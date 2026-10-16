import type { MediaServerKind } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { USER_TYPE, primaryServer } from '@server/lib/mediaServers';
import { Permission } from '@server/lib/permissions';

/**
 * Whether `actor` may change `target`'s account as someone else's: their
 * permissions, email, password, notification settings, passkeys or linked
 * media server account.
 *
 * Nobody manages their own account this way (changing your own permissions
 * would let anyone who manages users raise themselves), nobody but the
 * owner touches the owner's, and only the owner manages another admin: an
 * admin's email or password in the wrong hands is a way into everything.
 * Routes that also let people change their own settings use mayEditUser.
 */
export const mayManageUser = (actor: User | undefined, target: User): boolean =>
  !!actor &&
  actor.id !== target.id &&
  target.id !== 1 &&
  (actor.id === 1 || !target.hasPermission(Permission.ADMIN));

/**
 * Whether `actor` may change `target`'s own settings: their own, or those
 * of someone they may manage.
 */
export const mayEditUser = (actor: User | undefined, target: User): boolean =>
  actor?.id === target.id || mayManageUser(actor, target);

/**
 * Whether a Plex account may take over the account that has its email, on
 * signing in with Plex or on Import Plex Users. Only one waiting for its
 * Plex account: added by an admin as a Plex user by email, or the owner
 * linking Plex for the first time. Anyone can type someone else's email
 * into their own profile, so a password account, or one linked to another
 * Plex account, is never handed over this way; its owner links Plex from
 * their own settings instead.
 *
 * The owner only while Plex is the primary server: on a server set up with
 * Jellyfin or Emby, the owner's email says nothing about who holds a Plex
 * account, and the owner links Plex themselves.
 */
export const plexAccountMayClaim = (user: User): boolean =>
  !user.plexId &&
  (user.id === 1
    ? primaryServer() === 'plex'
    : user.userType === UserType.PLEX);

/**
 * No account but (optionally) this one has this email. A media server
 * account is never given an email another account already has.
 */
export const emailFree = async (
  email: string,
  exceptId?: number
): Promise<boolean> => {
  const holder = await getRepository(User)
    .createQueryBuilder('user')
    .select('user.id')
    .where('user.email = :email', { email: (email ?? '').toLowerCase() })
    .getOne();
  return !holder || holder.id === exceptId;
};

/**
 * Whether signing in with this server brings someone's picture (and, for
 * Plex, email) up to date: when it holds their main account, or they have
 * none but a password.
 */
export const mainAccountOn = (
  user: Pick<User, 'userType'>,
  kind: MediaServerKind
): boolean =>
  user.userType === USER_TYPE[kind] || user.userType === UserType.LOCAL;

/**
 * What a Plex account brings to the account it is linked to, on signing in
 * with Plex and on Import Plex Users alike: its picture and email only
 * when Plex is their main account (someone who signs in with Jellyfin or
 * Emby keeps what they have), and the email only when nobody else here
 * has it.
 */
export const plexProfileChanges = async (
  user: Pick<User, 'id' | 'userType'>,
  account: { thumb: string; email: string }
): Promise<Partial<User>> => {
  if (!mainAccountOn(user, 'plex')) {
    return {};
  }
  const changes: Partial<User> = { avatar: account.thumb };
  if (await emailFree(account.email, user.id)) {
    changes.email = account.email;
  }
  return changes;
};
