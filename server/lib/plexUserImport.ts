import PlexTvAPI from '@server/api/plextv';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import RemovedPlexAccount from '@server/entity/RemovedPlexAccount';
import { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

/*
 * Accounts for everyone the server owner shares Plex with, without anyone
 * pressing Import Plex Users. The same rules as that button: a Plex friend
 * with an email address and access to this server gets an account with the
 * default permissions. Unlike the button it only ever adds: an existing
 * account, including a local one with the same email, is left exactly as it
 * is, and an account an admin deleted stays deleted.
 */

class PlexUserImport {
  public running = false;

  public async run(): Promise<User[]> {
    const settings = getSettings();
    if (
      this.running ||
      !settings.main.autoImportPlexUsers ||
      settings.main.mediaServerType !== MediaServerType.PLEX ||
      !settings.plex.machineId
    ) {
      return [];
    }
    this.running = true;

    try {
      const repository = getRepository(User);
      const owner = await repository.findOne({
        select: { id: true, plexToken: true },
        where: { id: 1 },
      });
      if (!owner?.plexToken) {
        return [];
      }

      // One call for everyone: who is shared with, and on which servers.
      const response = await new PlexTvAPI(owner.plexToken).getUsers();
      const created: User[] = [];
      const removed = new Set(
        (
          await getRepository(RemovedPlexAccount).find({
            select: { plexId: true },
          })
        ).map((account) => account.plexId)
      );

      for (const rawUser of response.MediaContainer.User ?? []) {
        const account = rawUser.$;
        const hasAccess = !!rawUser.Server?.find(
          (server) => server.$.machineIdentifier === settings.plex.machineId
        );
        if (!account.email || !hasAccess || removed.has(Number(account.id))) {
          continue;
        }

        const existing = await repository
          .createQueryBuilder('user')
          .where('user.plexId = :id', { id: account.id })
          .orWhere('user.email = :email', {
            email: account.email.toLowerCase(),
          })
          .getOne();
        if (existing) {
          continue;
        }

        const user = await repository.save(
          new User({
            plexUsername: account.username,
            email: account.email,
            permissions: settings.main.defaultPermissions,
            plexId: parseInt(account.id),
            plexToken: '',
            avatar: account.thumb,
            userType: UserType.PLEX,
          })
        );
        created.push(user);
        logger.info('Imported a new Plex user', {
          label: 'Plex User Import',
          userId: user.id,
          plexUsername: account.username,
        });
      }

      return created;
    } catch (e) {
      logger.error('Plex user import failed', {
        label: 'Plex User Import',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      return [];
    } finally {
      this.running = false;
    }
  }
}

const plexUserImport = new PlexUserImport();

export default plexUserImport;
