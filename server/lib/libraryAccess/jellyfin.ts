import type { JellyfinFamilyKind } from '@server/constants/server';
import type { AccessLibraryType } from '@server/interfaces/api/libraryAccessInterfaces';
import type {
  AccessServer,
  ServerPerson,
} from '@server/lib/libraryAccess/types';
import { LibraryAccessError } from '@server/lib/libraryAccess/types';
import { jellyfinClient, jellyfinFamily } from '@server/lib/mediaServers';

/*
 * Jellyfin and Emby: each account's policy says whether it sees every
 * library or only those listed. Jellyfin lists a library by its Id, Emby
 * by its Guid; both are matched, whichever a policy holds.
 */

const TYPES: Record<string, AccessLibraryType> = {
  movies: 'movie',
  tvshows: 'show',
  music: 'music',
  photos: 'photo',
  homevideos: 'photo',
};

const plain = (id: string): string => id.replace(/-/g, '').toLowerCase();

export const jellyfinAccess = async (
  kind: JellyfinFamilyKind
): Promise<AccessServer> => {
  if (!jellyfinFamily(kind).apiKey) {
    throw new LibraryAccessError(
      400,
      `${kind === 'emby' ? 'Emby' : 'Jellyfin'} has no API key in Seerr AI.`
    );
  }
  const client = await jellyfinClient(kind);
  /** Every form a library goes by, plain, to its id here. */
  let names = new Map<string, string>();

  return {
    canGiveAll: true,

    async read(only) {
      const [folders, accounts] = await Promise.all([
        client.getAccessFolders(),
        client.getPolicyAccounts(),
      ]);
      const libraries = folders.map((folder) => ({
        id: kind === 'emby' && folder.Guid ? folder.Guid : folder.Id,
        title: folder.Name,
        type: TYPES[folder.CollectionType ?? ''] ?? 'other',
      }));
      names = new Map();
      folders.forEach((folder, i) => {
        names.set(plain(folder.Id), libraries[i].id);
        if (folder.Guid) names.set(plain(folder.Guid), libraries[i].id);
      });
      const all = libraries.map((library) => library.id);

      const people = accounts
        .filter((account) => !only || plain(account.Id) === plain(only))
        .map((account): ServerPerson => {
          const policy = account.Policy ?? {};
          const everything = !!policy.EnableAllFolders;
          const listed = new Set(
            (policy.EnabledFolders ?? [])
              .map((id) => names.get(plain(id)))
              .filter((id): id is string => !!id)
          );
          return {
            id: account.Id,
            name: account.Name,
            ref: account.Id,
            all: everything,
            libraries: everything ? all : all.filter((id) => listed.has(id)),
            ...(policy.IsAdministrator ? { admin: true } : {}),
            ...(policy.IsDisabled ? { disabled: true } : {}),
          };
        });
      return { libraries, people };
    },

    async write(person, to) {
      // Read afresh, so nothing else in the policy is put back as it was.
      const { Policy: policy } = await client.getPolicyAccount(person.ref);
      // Libraries listed that the server no longer has stay listed.
      const unknown = (policy.EnabledFolders ?? []).filter(
        (id) => !names.has(plain(id))
      );
      await client.setPolicy(person.ref, {
        ...policy,
        EnableAllFolders: to.all,
        EnabledFolders: to.all ? unknown : [...unknown, ...to.libraries],
      });
    },
  };
};
