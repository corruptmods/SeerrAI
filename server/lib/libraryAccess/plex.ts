import PlexTvAPI from '@server/api/plextv';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import type { AccessLibraryType } from '@server/interfaces/api/libraryAccessInterfaces';
import type {
  AccessServer,
  ServerPerson,
} from '@server/lib/libraryAccess/types';
import { LibraryAccessError } from '@server/lib/libraryAccess/types';
import { getSettings } from '@server/lib/settings';
import { mapWithConcurrency } from '@server/utils/mapWithConcurrency';

// Plex shares via plex.tv with the owner's token. The owner is never listed.

const TYPES: Record<string, AccessLibraryType> = {
  movie: 'movie',
  show: 'show',
  artist: 'music',
  photo: 'photo',
};

/** Parallel share reads. */
const CONCURRENCY = 4;

export const plexAccess = async (): Promise<AccessServer> => {
  const { machineId } = getSettings().plex;
  const owner = await getRepository(User).findOne({
    where: { id: 1 },
    select: { id: true, plexToken: true },
  });
  if (!machineId || !owner?.plexToken) {
    throw new LibraryAccessError(
      400,
      'Plex sharing needs the owner’s Plex account: link it under Linked Accounts.'
    );
  }
  const plexTv = new PlexTvAPI(owner.plexToken);

  return {
    canGiveAll: false,

    async read(only) {
      const [sections, users] = await Promise.all([
        plexTv.getSharingSections(machineId),
        plexTv.getUsers(),
      ]);
      const libraries = sections.map((section) => ({
        id: section.id,
        title: section.title,
        type: TYPES[section.type] ?? 'other',
      }));
      const all = libraries.map((library) => library.id);

      const shares = (users.MediaContainer?.User ?? [])
        .filter((user) => !only || user.$.id === only)
        .flatMap((user) => {
          const server = user.Server?.find(
            (s) => s.$.machineIdentifier === machineId
          );
          return server ? [{ user: user.$, server: server.$ }] : [];
        });

      const people = await mapWithConcurrency(
        shares,
        CONCURRENCY,
        async ({ user, server }): Promise<ServerPerson> => {
          const everything = server.allLibraries === '1';
          const shared = everything
            ? all
            : (await plexTv.getShareSections(machineId, server.id))
                .filter((section) => section.shared)
                .map((section) => section.id)
                .filter((id) => all.includes(id));
          return {
            id: user.id,
            name: user.username || user.title || user.id,
            ref: server.id,
            all: everything,
            libraries: everything
              ? all
              : all.filter((id) => shared.includes(id)),
          };
        }
      );
      return {
        libraries,
        people,
        scanIds: new Map(sections.map((section) => [section.id, section.key])),
      };
    },

    async write(person, to, access) {
      const ids = to.all
        ? access.libraries.map((library) => library.id)
        : to.libraries;
      await plexTv.setShareSections(machineId, person.ref, ids);
    },
  };
};
