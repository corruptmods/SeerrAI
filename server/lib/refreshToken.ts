import PlexTvAPI from '@server/api/plextv';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { isConnected } from '@server/lib/mediaServers';
import logger from '@server/logger';

class RefreshToken {
  public async run() {
    // Plex sign-ins only matter while Seerr is connected to Plex.
    if (!isConnected('plex')) {
      return;
    }

    const users = await getRepository(User)
      .createQueryBuilder('user')
      .addSelect('user.plexToken')
      .where("user.plexToken != ''")
      .getMany();

    for (const user of users) {
      await this.refreshUserToken(user);
    }
  }

  private async refreshUserToken(user: User) {
    if (!user.plexToken) {
      logger.warn('Skipping user refresh token for user without plex token', {
        label: 'Plex Refresh Token',
        user: user.displayName,
      });
      return;
    }

    new PlexTvAPI(user.plexToken).pingToken();
  }
}

const refreshToken = new RefreshToken();

export default refreshToken;
