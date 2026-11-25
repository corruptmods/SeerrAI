import { SiloError } from '@server/api/silo/client';
import type { SiloAdminUser } from '@server/api/silo/types';
import type { AccessLibraryType } from '@server/interfaces/api/libraryAccessInterfaces';
import type {
  AccessServer,
  ServerPerson,
} from '@server/lib/libraryAccess/types';
import { LibraryAccessError } from '@server/lib/libraryAccess/types';
import {
  SILO_NEEDS_USERS_SCOPE,
  SILO_RESETTING,
  siloClient,
  siloEpoch,
  siloEpochCurrent,
  siloHasScope,
  siloLibraryType,
  siloSettings,
} from '@server/lib/silo';

/*
 * Silo accounts list their libraries, or none to follow their access group
 * (every library for an account outside one). Changing them needs the
 * optional admin:users scope on Seerr AI's key. Administrators are never
 * changed here, as on Jellyfin and Emby.
 */

const TYPES: Record<string, AccessLibraryType> = {
  movie: 'movie',
  show: 'show',
};

/** The libraries Silo enforces for an account; null for every one. */
const enforced = (account: SiloAdminUser): string[] | null => {
  const effective = account.effective_policy?.library_ids;
  if (effective !== undefined) return effective;
  return account.library_ids ?? null;
};

/** A refused change in words; a missing scope names it. */
const refusal = (e: unknown): Error => {
  if (e instanceof SiloError && e.status === 403) {
    return new Error(SILO_NEEDS_USERS_SCOPE);
  }
  return e instanceof Error ? e : new Error(String(e));
};

export const siloAccess = async (): Promise<AccessServer> => {
  if (!siloSettings().apiKey) {
    throw new LibraryAccessError(400, 'Silo has no API key in Seerr AI.');
  }
  if (!siloHasScope('admin:users')) {
    throw new LibraryAccessError(400, SILO_NEEDS_USERS_SCOPE);
  }
  // Accounts are matched to people here by their Silo links, which name the
  // old Silo's accounts while a different one's reset is under way; work
  // begun before a reset was marked stops (siloEpoch).
  const epoch = siloEpoch();
  const unchanged = () => {
    if (!siloEpochCurrent(epoch)) {
      throw new LibraryAccessError(503, SILO_RESETTING);
    }
  };
  unchanged();
  const client = siloClient();
  /** Every library id Silo listed, to keep any other an account holds. */
  let known = new Set<string>();

  return {
    // An account that lists no libraries follows its group; see write.
    canGiveAll: true,

    async read(only) {
      const [found, listed] = await Promise.all([
        client.getUserLibraries(),
        only
          ? client.getAdminUser(only).then(
              (account): SiloAdminUser[] => [account],
              (e: unknown) => {
                if (e instanceof SiloError && e.status === 404) return [];
                throw e;
              }
            )
          : client.listAdminUsers(),
      ]);
      unchanged();
      const libraries = found.map((library) => ({
        id: library.id,
        title: library.name,
        type: TYPES[siloLibraryType(library.type ?? '') ?? ''] ?? 'other',
      }));
      known = new Set(libraries.map((library) => library.id));
      const all = libraries.map((library) => library.id);
      const accounts = listed.filter((account) => !only || account.id === only);
      const people = accounts.map((account): ServerPerson => {
        const allowed = enforced(account);
        // Every library for an account its group limits is written as a
        // list of them all (see write), and reads back as every library.
        const everything =
          allowed === null ||
          (!!account.access_group_id &&
            account.library_ids != null &&
            all.length > 0 &&
            all.every((id) => allowed.includes(id)));
        return {
          id: account.id,
          name: account.username,
          ref: account.id,
          all: everything,
          libraries: everything
            ? all
            : all.filter((id) => allowed.includes(id)),
          ...(account.role === 'admin' ? { admin: true } : {}),
          ...(account.enabled === false ? { disabled: true } : {}),
        };
      });
      return { libraries, people };
    },

    async write(person, to) {
      unchanged();
      try {
        // Read fresh: Silo changes an account only against its latest tag.
        const { account, tag } = await client.getAdminUserForChange(person.ref);
        unchanged();
        if (account.role === 'admin') {
          throw new Error(
            `${person.name} is now an administrator in Silo, so their libraries are left as they are.`
          );
        }
        // Keep libraries Silo didn't list here (one it hides, say).
        const unknown = (account.library_ids ?? []).filter(
          (id) => !known.has(id)
        );
        if (!to.all) {
          await client.updateAdminUser(person.ref, tag, {
            library_ids: [...unknown, ...to.libraries],
          });
          return;
        }
        // Every library: follow the access group, which for an account
        // outside one is every library, including new ones. A group that
        // limits it can't be overridden with "every library" in Silo, so
        // today's libraries are listed instead (a later one isn't given).
        await client.updateAdminUser(person.ref, tag, { library_ids: null });
        const after = await client.getAdminUserForChange(person.ref);
        unchanged();
        if (enforced(after.account) !== null) {
          // Its group limits it: list every library instead.
          await client.updateAdminUser(person.ref, after.tag, {
            library_ids: [...unknown, ...known],
          });
        }
      } catch (e) {
        if (e instanceof LibraryAccessError) throw e;
        throw refusal(e);
      }
    },
  };
};
