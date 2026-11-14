import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';

/*
 * A page's first API calls arrive together, and each read the signed-in user.
 * Calls within a moment of each other share one read. Any write to users or
 * their settings, and any transaction ending anywhere, makes every earlier read
 * unusable (UserSubscriber), so a change shows on the very next request, as
 * when every request read the database.
 */

/** How long one read serves later calls. */
const KEEP_MS = 2000;
/** Users kept at once. */
const MAX_KEPT = 1000;

interface Read {
  generation: number;
  at: number;
  user: Promise<User | null>;
}

let generation = 0;
const reads = new Map<number, Read>();

/** Called after anything that may have changed a user: drops every read. */
export const usersChanged = (): void => {
  generation += 1;
  reads.clear();
};

/**
 * Each caller gets its own copy, so a route changing its req.user (and not
 * saving) never shows in another request.
 */
const copyOf = (user: User): User => {
  const copy = Object.assign(
    Object.create(User.prototype) as User,
    structuredClone({ ...user })
  );
  if (copy.settings) {
    Object.setPrototypeOf(copy.settings, UserSettings.prototype);
  }
  return copy;
};

/** The user a session belongs to, with their settings. */
export const sessionUser = async (id: number): Promise<User | null> => {
  const now = Date.now();
  let read = reads.get(id);
  if (!read || read.generation !== generation || now - read.at >= KEEP_MS) {
    // Tagged with the generation before the read starts: a change that lands
    // while it runs makes it stale at once.
    read = {
      generation,
      at: now,
      user: getRepository(User).findOne({ where: { id } }),
    };
    reads.delete(id);
    if (reads.size >= MAX_KEPT) {
      reads.delete(reads.keys().next().value as number);
    }
    reads.set(id, read);
    const started = read;
    started.user.catch(() => {
      if (reads.get(id) === started) {
        reads.delete(id);
      }
    });
  }
  const user = await read.user;
  return user && copyOf(user);
};
