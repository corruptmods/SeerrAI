import { standInEmail } from '@server/constants/oidc';
import type { MediaServerKind } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { USER_TYPE, primaryServer } from '@server/lib/mediaServers';
import { Permission } from '@server/lib/permissions';
import logger from '@server/logger';
import { randomUUID } from 'node:crypto';

/**
 * Whether `actor` may change `target`'s account on their behalf: permissions,
 * email, password, notification settings, passkeys or linked media server
 * account.
 *
 * Never one's own account (else any user manager could raise their own
 * permissions); only the owner touches the owner's account; only the owner
 * manages another admin, since an admin's email or password in the wrong
 * hands opens everything. Routes that also allow self-edits use mayEditUser.
 */
export const mayManageUser = (actor: User | undefined, target: User): boolean =>
  !!actor &&
  actor.id !== target.id &&
  target.id !== 1 &&
  (actor.id === 1 || !target.hasPermission(Permission.ADMIN));

/**
 * Whether `actor` may change `target`'s settings: their own, or a user they may
 * manage.
 */
export const mayEditUser = (actor: User | undefined, target: User): boolean =>
  actor?.id === target.id || mayManageUser(actor, target);

/**
 * Whether a Plex account may take over the account with its email, on Plex
 * sign-in or Import Plex Users. Only an account waiting for its Plex account:
 * added by an admin as a Plex user by email, or the owner linking Plex for the
 * first time. Anyone can type another's email into their profile, so a
 * password account, one linked to another Plex account or one with an
 * unconfirmed email is never handed over; its owner links Plex from their own
 * settings.
 *
 * The owner only while Plex is primary: on a Jellyfin or Emby setup the
 * owner's email says nothing about who holds a Plex account, and the owner
 * links Plex themselves.
 */
export const plexAccountMayClaim = (user: User): boolean =>
  !user.plexId &&
  user.emailVerified !== false &&
  (user.id === 1
    ? primaryServer() === 'plex'
    : user.userType === UserType.PLEX);

/**
 * Whether no account (other than the optional one) has this email. A media
 * server account never gets an email another account already has.
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
 * Whether an account a media server or sign-in provider brings may have this
 * email: no one else has it, or only someone who set it on themselves and
 * never confirmed it, who then gets a stand-in in its place.
 */
export const takeEmail = async (
  email: string,
  exceptId?: number
): Promise<boolean> => {
  const userRepository = getRepository(User);
  const holder = await userRepository
    .createQueryBuilder('user')
    .select(['user.id', 'user.emailVerified'])
    .where('user.email = :email', { email: (email ?? '').toLowerCase() })
    .getOne();
  if (!holder || holder.id === exceptId) {
    return true;
  }
  if (holder.emailVerified) {
    return false;
  }
  await userRepository.update(holder.id, {
    email: standInEmail('unconfirmed', randomUUID()),
  });
  logger.warn(
    'An unconfirmed email went to the account that signed in with it; the account that had it needs a new one',
    { label: 'User Management', userId: holder.id }
  );
  return true;
};

/**
 * Whether signing in with this server updates the user's avatar (and, for
 * Plex, email): when it holds their main account, or they only have a
 * password.
 */
export const mainAccountOn = (
  user: Pick<User, 'userType'>,
  kind: MediaServerKind
): boolean =>
  user.userType === USER_TYPE[kind] || user.userType === UserType.LOCAL;

/**
 * What a Plex account brings to its linked account, on Plex sign-in and Import
 * Plex Users alike: avatar and email only when Plex is their main account
 * (Jellyfin or Emby users keep theirs), and email only when no one else here
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
    changes.emailVerified = true;
  }
  return changes;
};
