import { ApiErrorCode } from '@server/constants/error';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { withNewUserDefaults } from '@server/lib/newUserDefaults';
import { getSettings } from '@server/lib/settings';
import { assertSiloEpoch, siloEpoch } from '@server/lib/silo';
import { enabledSiloAccounts, siloAvatarPath } from '@server/lib/siloAccounts';
import { siloAccountToRelink } from '@server/lib/siloConnect';
import logger from '@server/logger';
import { checkAvatarChanged } from '@server/routes/avatarproxy';
import { In } from 'typeorm';

/*
 * Import Silo Users: Silo's switched-on accounts, as Import Jellyfin Users
 * does. New ones (all, or those chosen) get an account; ones imported before
 * get their name and picture refreshed. Someone whose name is already another
 * account's is skipped with the reason: they sign in with that account and
 * link Silo.
 */

/** Accounts here holding these Silo accounts, by Silo id. */
const holders = async (ids: string[]): Promise<Map<string, User>> => {
  const found = ids.length
    ? await getRepository(User).find({ where: { siloUserId: In(ids) } })
    : [];
  return new Map(found.map((user) => [user.siloUserId ?? '', user]));
};

/** Silo accounts not imported yet, for choosing whom to import. */
export const siloUsersToImport = async (): Promise<
  { id: string; username: string; email: string; thumb: string }[]
> => {
  const epoch = siloEpoch();
  const accounts = await enabledSiloAccounts();
  assertSiloEpoch(epoch);
  const linked = await holders(accounts.map((account) => account.id));
  assertSiloEpoch(epoch);
  return accounts
    .filter((account) => !linked.has(account.id))
    .map((account) => ({
      id: account.id,
      username: account.username,
      email: account.username,
      thumb: siloAvatarPath(account.id),
    }))
    .sort((a, b) => a.username.localeCompare(b.username));
};

export const importSiloUsers = async (chosenIds: string[] | undefined) => {
  const settings = getSettings();
  const userRepository = getRepository(User);
  // Silo's accounts are the old Silo's if a reset is marked meanwhile:
  // checked before each read and write here (siloEpoch).
  const epoch = siloEpoch();
  const accounts = await enabledSiloAccounts();
  assertSiloEpoch(epoch);
  const linked = await holders(accounts.map((account) => account.id));
  // No list imports everyone new, as on Import Plex Users.
  const chosen = chosenIds ? new Set(chosenIds) : null;

  const createdUsers: User[] = [];
  const skippedUsers: { id: string; name: string; reason: string }[] = [];
  let refreshedUsers = 0;

  for (const account of accounts) {
    const user = linked.get(account.id);
    if (user) {
      // Imported before: name, and the picture when Silo is their main
      // account. Settings and permissions are untouched.
      const { changed } =
        user.userType === UserType.SILO
          ? await checkAvatarChanged(user, 'silo')
          : { changed: false };
      assertSiloEpoch(epoch);
      await userRepository.update(user.id, {
        siloUsername: account.username,
        ...(changed
          ? { avatar: siloAvatarPath(account.id, user.avatarVersion) }
          : {}),
      });
      refreshedUsers += 1;
      continue;
    }
    if (chosen && !chosen.has(account.id)) continue;

    // An account a different Silo's reset unlinked, with this Silo name,
    // is linked again rather than left out for its name.
    assertSiloEpoch(epoch);
    const unlinked = await siloAccountToRelink(account);
    assertSiloEpoch(epoch);
    // Only while still unlinked: someone linked it meanwhile keeps it.
    const relinked = unlinked
      ? await userRepository
          .createQueryBuilder()
          .update(User)
          .set({
            siloUserId: account.id,
            siloUsername: account.username,
            siloProfileId: null,
            siloRelinkUntil: null,
            avatar: siloAvatarPath(account.id, unlinked.avatarVersion),
          })
          .where('id = :id AND siloUserId IS NULL', { id: unlinked.id })
          .execute()
      : undefined;
    if (relinked?.affected) {
      logger.info('Silo user linked again after a different Silo', {
        label: 'API',
        siloUserId: account.id,
      });
      refreshedUsers += 1;
      continue;
    }

    assertSiloEpoch(epoch);
    const taken = await userRepository
      .createQueryBuilder('user')
      .where('user.email = :email', { email: account.username.toLowerCase() })
      .getExists();
    if (taken) {
      logger.info(
        'Silo user not imported: another account already has their name as its email',
        { label: 'API', siloUserId: account.id }
      );
      skippedUsers.push({
        id: account.id,
        name: account.username,
        reason: ApiErrorCode.ExistingAccount,
      });
      continue;
    }

    const newUser = withNewUserDefaults(
      new User({
        email: account.username,
        siloUserId: account.id,
        siloUsername: account.username,
        permissions: settings.main.defaultPermissions,
        avatar: siloAvatarPath(account.id),
        userType: UserType.SILO,
      })
    );
    assertSiloEpoch(epoch);
    await userRepository.save(newUser);
    createdUsers.push(newUser);
  }

  return {
    createdUsers: User.filterMany(createdUsers),
    refreshedUsers,
    skippedUsers,
  };
};
