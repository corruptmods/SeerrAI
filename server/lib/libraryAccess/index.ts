import type { MediaServerKind } from '@server/constants/server';
import { USER_ID, isJellyfinFamily } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import type { LibraryAccessEntry } from '@server/entity/LibraryAccessChange';
import LibraryAccessChange from '@server/entity/LibraryAccessChange';
import { User } from '@server/entity/User';
import type {
  AccessBulkAction,
  AccessChangeView,
  AccessPerson,
  AccessPlan,
  AccessResult,
  AccessSet,
  LibraryAccessView,
  UserLibraryAccess,
} from '@server/interfaces/api/libraryAccessInterfaces';
import cacheManager from '@server/lib/cache';
import { jellyfinAccess } from '@server/lib/libraryAccess/jellyfin';
import { plexAccess } from '@server/lib/libraryAccess/plex';
import type {
  AccessServer,
  ServerAccess,
  ServerPerson,
} from '@server/lib/libraryAccess/types';
import { LibraryAccessError } from '@server/lib/libraryAccess/types';
import { connectedServers, serverName } from '@server/lib/mediaServers';
import logger from '@server/logger';
import { normalizeJellyfinGuid } from '@server/utils/jellyfin';
import { In } from 'typeorm';

/*
 * Library sharing on Plex, Jellyfin and Emby: per person, or one library for
 * everyone at once. Jellyfin/Emby admins are never changed; nobody is left
 * with no library. Each change is recorded for history and Undo.
 */

export { LibraryAccessError };

interface Move {
  person: ServerPerson;
  to: AccessSet;
}

const sameSet = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((id) => b.includes(id));

/** Normalizes a server person id to the form stored on User. */
const plainId = (kind: MediaServerKind, id: string): string =>
  kind === 'plex' ? id : (normalizeJellyfinGuid(id) ?? id);

/** Plans a bulk add/remove of one library, with the moves to make. */
export const planBulk = (
  kind: MediaServerKind,
  access: ServerAccess,
  libraryId: string,
  action: AccessBulkAction
): AccessPlan & { moves: Move[] } => {
  const library = access.libraries.find((l) => l.id === libraryId);
  if (!library) {
    throw new LibraryAccessError(404, 'That library is not on the server.');
  }
  const all = access.libraries.map((l) => l.id);
  const plan: AccessPlan & { moves: Move[] } = {
    kind,
    library,
    action,
    change: [],
    fromAll: 0,
    emptied: [],
    unchanged: 0,
    admins: 0,
    moves: [],
  };
  for (const person of access.people) {
    if (person.admin) {
      plan.admins += 1;
      continue;
    }
    const has = person.libraries.includes(libraryId);
    const who = {
      id: person.id,
      name: person.name,
      ...(person.userId ? { userId: person.userId } : {}),
    };
    if (action === 'remove') {
      if (!has) {
        plan.unchanged += 1;
        continue;
      }
      const rest = person.libraries.filter((id) => id !== libraryId);
      if (!rest.length) {
        plan.emptied.push(who);
        continue;
      }
      if (person.all) plan.fromAll += 1;
      plan.change.push(who);
      plan.moves.push({ person, to: { all: false, libraries: rest } });
    } else {
      if (has) {
        plan.unchanged += 1;
        continue;
      }
      plan.change.push(who);
      plan.moves.push({
        person,
        to: {
          all: false,
          libraries: all.filter(
            (id) => id === libraryId || person.libraries.includes(id)
          ),
        },
      });
    }
  }
  return plan;
};

/** Strips the server handle (`ref`) before sending to clients. */
const publicPerson = (person: ServerPerson): AccessPerson => {
  const copy: Partial<ServerPerson> = { ...person };
  delete copy.ref;
  return copy as AccessPerson;
};

const why = (e: unknown): string => {
  const status = (e as { response?: { status?: number } })?.response?.status;
  if (status) return `The server answered ${status}.`;
  return e instanceof Error ? e.message : String(e);
};

class LibraryAccess {
  private busy = new Set<MediaServerKind>();

  /** The access reader/writer for a connected server. */
  public async server(kind: MediaServerKind): Promise<AccessServer> {
    if (!connectedServers().includes(kind)) {
      throw new LibraryAccessError(
        404,
        `${serverName(kind)} is not connected.`
      );
    }
    return isJellyfinFamily(kind) ? jellyfinAccess(kind) : plexAccess();
  }

  /** Reads the server and attaches linked Seerr AI user ids. */
  private async read(
    kind: MediaServerKind,
    server: AccessServer,
    only?: string
  ): Promise<ServerAccess> {
    const access = await server.read(only);
    const column = USER_ID[kind];
    const users = await getRepository(User)
      .createQueryBuilder('user')
      .select(['user.id', `user.${column}`])
      .where(`user.${column} IS NOT NULL`)
      .getMany();
    const byId = new Map(
      users.map((user) => [plainId(kind, String(user[column])), user.id])
    );
    for (const person of access.people) {
      const userId = byId.get(plainId(kind, person.id));
      if (userId) person.userId = userId;
    }
    return access;
  }

  public async view(kind: MediaServerKind): Promise<LibraryAccessView> {
    const access = await this.read(kind, await this.server(kind));
    const people = access.people.filter((person) => !person.admin);
    return {
      kind,
      libraries: access.libraries.map((library) => ({
        ...library,
        sharedWith: people.filter((p) => p.libraries.includes(library.id))
          .length,
      })),
      people: access.people.map(publicPerson),
    };
  }

  /** Previews a bulk change without making it. */
  public async plan(
    kind: MediaServerKind,
    libraryId: string,
    action: AccessBulkAction
  ): Promise<AccessPlan> {
    const access = await this.read(kind, await this.server(kind));
    const plan: AccessPlan & { moves?: Move[] } = planBulk(
      kind,
      access,
      libraryId,
      action
    );
    delete plan.moves;
    return plan;
  }

  /** Runs one change at a time per server. */
  private async exclusive<T>(
    kind: MediaServerKind,
    work: () => Promise<T>
  ): Promise<T> {
    if (this.busy.has(kind)) {
      throw new LibraryAccessError(
        409,
        `A change to ${serverName(kind)}’s libraries is already being made.`
      );
    }
    this.busy.add(kind);
    try {
      return await work();
    } finally {
      this.busy.delete(kind);
      // What people may see follows the change at once (lib/libraryVisibility).
      cacheManager.getCache('libraryaccess').flush();
    }
  }

  /** Applies moves in turn; a failure is recorded and the rest continue. */
  private async make(
    server: AccessServer,
    access: ServerAccess,
    moves: Move[]
  ): Promise<LibraryAccessEntry[]> {
    const entries: LibraryAccessEntry[] = [];
    for (const { person, to } of moves) {
      const entry: LibraryAccessEntry = {
        id: person.id,
        name: person.name,
        before: { all: person.all, libraries: person.libraries },
        after: to,
      };
      try {
        await server.write(person, to, access);
      } catch (e) {
        entry.error = why(e);
      }
      entries.push(entry);
    }
    return entries;
  }

  private async record(change: LibraryAccessChange): Promise<AccessResult> {
    const saved = await getRepository(LibraryAccessChange).save(change);
    const [view] = await this.views([saved]);
    const failed = saved.entries.filter((entry) => entry.error);
    return {
      change: view,
      changed: saved.entries.length - failed.length,
      failed: failed.map((entry) => ({
        name: entry.name,
        error: entry.error ?? '',
      })),
    };
  }

  /** Removes a library from, or adds it to, everyone. */
  public async apply(
    kind: MediaServerKind,
    libraryId: string,
    action: AccessBulkAction,
    userId: number
  ): Promise<AccessResult> {
    return this.exclusive(kind, async () => {
      const server = await this.server(kind);
      const access = await this.read(kind, server);
      const plan = planBulk(kind, access, libraryId, action);
      if (!plan.moves.length) {
        throw new LibraryAccessError(400, 'Nobody would change.');
      }
      const entries = await this.make(server, access, plan.moves);
      const result = await this.record(
        new LibraryAccessChange({
          serverKind: kind,
          action,
          libraryId,
          libraryTitle: plan.library.title,
          userId,
          entries,
        })
      );
      logger.info(
        `${action === 'remove' ? 'Took' : 'Gave'} ${serverName(kind)} library ${plan.library.title} ${action === 'remove' ? 'from' : 'to'} ${result.changed} people`,
        {
          label: 'Library Access',
          failed: result.failed.length,
          leftAsTheyWere: plan.emptied.length,
        }
      );
      return result;
    });
  }

  /** Sets one person's libraries, or all. */
  public async setPerson(
    kind: MediaServerKind,
    personId: string,
    wanted: AccessSet,
    userId: number
  ): Promise<AccessResult> {
    return this.exclusive(kind, async () => {
      const server = await this.server(kind);
      const access = await this.read(kind, server, personId);
      const person = access.people.find(
        (p) => plainId(kind, p.id) === plainId(kind, personId)
      );
      if (!person) {
        throw new LibraryAccessError(
          404,
          `${serverName(kind)} is not shared with them.`
        );
      }
      if (person.admin) {
        throw new LibraryAccessError(400, 'Administrators see every library.');
      }
      if (wanted.all && !server.canGiveAll) {
        throw new LibraryAccessError(
          400,
          `${serverName(kind)} cannot be told to share new libraries from here.`
        );
      }
      const all = access.libraries.map((l) => l.id);
      const to: AccessSet = wanted.all
        ? { all: true, libraries: all }
        : {
            all: false,
            libraries: all.filter((id) => wanted.libraries.includes(id)),
          };
      if (!to.libraries.length) {
        throw new LibraryAccessError(
          400,
          `Leave at least one library. To stop sharing with someone, do it in ${serverName(kind)}.`
        );
      }
      if (to.all === person.all && sameSet(to.libraries, person.libraries)) {
        return { changed: 0, failed: [] };
      }
      const entries = await this.make(server, access, [{ person, to }]);
      return this.record(
        new LibraryAccessChange({
          serverKind: kind,
          action: 'person',
          libraryId: null,
          libraryTitle: null,
          userId,
          entries,
        })
      );
    });
  }

  /** Reverts a change, skipping anyone changed again since. */
  public async undo(id: number): Promise<AccessResult> {
    const repo = getRepository(LibraryAccessChange);
    const found = await repo.findOneBy({ id });
    if (!found) {
      throw new LibraryAccessError(404, 'That change is not in the history.');
    }
    const kind = found.serverKind;
    return this.exclusive(kind, async () => {
      // Read again under the lock, so a change is undone once.
      const change = await repo.findOneBy({ id });
      if (!change) {
        throw new LibraryAccessError(404, 'That change is not in the history.');
      }
      if (change.undoneAt) {
        throw new LibraryAccessError(409, 'That change was already undone.');
      }
      const server = await this.server(kind);
      const access = await this.read(kind, server);
      const all = access.libraries.map((l) => l.id);
      const moves: Move[] = [];
      let skipped = 0;
      for (const entry of change.entries) {
        if (entry.error) continue;
        const person = access.people.find((p) => p.id === entry.id);
        if (
          !person ||
          person.admin ||
          !sameSet(
            person.libraries,
            entry.after.libraries.filter((l) => all.includes(l))
          )
        ) {
          skipped += 1;
          continue;
        }
        const back = entry.before.libraries.filter((l) => all.includes(l));
        const to =
          entry.before.all && server.canGiveAll
            ? { all: true, libraries: all }
            : { all: false, libraries: entry.before.all ? all : back };
        // Their libraries then are gone: nobody is left with none.
        if (!to.all && !to.libraries.length) {
          skipped += 1;
          continue;
        }
        moves.push({ person, to });
      }
      const entries = await this.make(server, access, moves);
      change.undoneAt = new Date();
      await repo.save(change);
      const failed = entries.filter((entry) => entry.error);
      logger.info(`Undid a change to ${serverName(kind)} library access`, {
        label: 'Library Access',
        changeId: id,
        restored: entries.length - failed.length,
        failed: failed.length,
        skipped,
      });
      const [view] = await this.views([change]);
      return {
        change: view,
        changed: entries.length - failed.length,
        failed: failed.map((entry) => ({
          name: entry.name,
          error: entry.error ?? '',
        })),
        skipped,
      };
    });
  }

  public async history(
    kind?: MediaServerKind,
    take = 20
  ): Promise<AccessChangeView[]> {
    const rows = await getRepository(LibraryAccessChange).find({
      where: kind ? { serverKind: kind } : {},
      order: { id: 'DESC' },
      take,
    });
    return this.views(rows);
  }

  private async views(
    rows: LibraryAccessChange[]
  ): Promise<AccessChangeView[]> {
    const ids = [
      ...new Set(rows.map((row) => row.userId).filter((id) => id != null)),
    ] as number[];
    const users = ids.length
      ? await getRepository(User).find({ where: { id: In(ids) } })
      : [];
    const names = new Map(users.map((user) => [user.id, user.displayName]));
    return rows.map((row) => {
      const failed = row.entries.filter((entry) => entry.error).length;
      return {
        id: row.id,
        kind: row.serverKind,
        action: row.action,
        ...(row.libraryTitle ? { libraryTitle: row.libraryTitle } : {}),
        ...(row.action === 'person' && row.entries[0]
          ? { personName: row.entries[0].name }
          : {}),
        ...(row.userId && names.get(row.userId)
          ? { byName: names.get(row.userId) }
          : {}),
        createdAt: new Date(row.createdAt).toISOString(),
        ...(row.undoneAt
          ? { undoneAt: new Date(row.undoneAt).toISOString() }
          : {}),
        changed: row.entries.length - failed,
        failed,
      };
    });
  }

  /** A user's libraries on each connected server they're linked to. */
  public async forUser(userId: number): Promise<UserLibraryAccess[]> {
    const user = await getRepository(User).findOne({ where: { id: userId } });
    if (!user) {
      throw new LibraryAccessError(404, 'There is no such user.');
    }
    const out: UserLibraryAccess[] = [];
    for (const kind of connectedServers()) {
      const linked = user[USER_ID[kind]];
      if (!linked) continue;
      try {
        const server = await this.server(kind);
        const access = await this.read(kind, server, String(linked));
        const found = access.people.find(
          (p) => plainId(kind, p.id) === plainId(kind, String(linked))
        );
        out.push({
          kind,
          libraries: access.libraries,
          canGiveAll: server.canGiveAll,
          ...(found ? { person: publicPerson(found) } : {}),
        });
      } catch (e) {
        logger.warn(`Could not read ${serverName(kind)} library access`, {
          label: 'Library Access',
          errorMessage: e instanceof Error ? e.message : String(e),
        });
        out.push({
          kind,
          libraries: [],
          canGiveAll: false,
          error: e instanceof LibraryAccessError ? e.message : why(e),
        });
      }
    }
    return out;
  }
}

const libraryAccess = new LibraryAccess();

export default libraryAccess;
