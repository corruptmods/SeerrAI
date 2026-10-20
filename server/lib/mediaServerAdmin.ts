import type { MediaServerKind } from '@server/constants/server';
import {
  MEDIA_ID,
  MUSIC_ALBUM_ID,
  USER_ID,
  isJellyfinFamily,
  typeOfKind,
} from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MusicAlbum from '@server/entity/MusicAlbum';
import { User } from '@server/entity/User';
import type { MediaServerRemovalImpact } from '@server/interfaces/api/mediaServerInterfaces';
import { refreshMediaServerJobs } from '@server/job/schedule';
import availabilitySync from '@server/lib/availabilitySync';
import matchWatch from '@server/lib/matchWatch';
import {
  connectedServers,
  linkedServers,
  primaryServer,
  serverName,
} from '@server/lib/mediaServers';
import { usableProviderLinks } from '@server/lib/oidc';
import type { MediaServerName } from '@server/lib/plexMatchCheck';
import plexMatchCheck from '@server/lib/plexMatchCheck';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { IsNull, Not } from 'typeorm';

/*
 * What Settings → Media Servers changes: which servers Seerr is connected
 * to, which one is primary, and which ones people may sign in with.
 */

/** Why a change to the media servers was refused, with the status to answer. */
export class MediaServerChangeError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/** Some connected server lets people sign in with it. */
const anyServerAllowsSignIn = (): boolean => {
  const settings = getSettings();
  return connectedServers().some((kind) => settings[kind].signIn !== false);
};

/**
 * Keeps the old single switch for media server sign-in
 * (main.mediaServerLogin), which pages and API clients still read, in step
 * with each server's own: on while any connected server allows sign-in.
 * Before any server is connected it is left as it is, as setup reads it.
 * The caller saves.
 */
export const deriveMediaServerLogin = (): void => {
  if (!connectedServers().length) return;
  getSettings().main.mediaServerLogin = anyServerAllowsSignIn();
};

/**
 * Settings → Users has one switch standing for every connected server's.
 * Changing it turns them all on or off; saving it unchanged leaves each
 * server's own switch as it is. The caller saves.
 */
export const applyMediaServerLogin = (wanted: boolean | undefined): void => {
  if (typeof wanted === 'boolean' && connectedServers().length) {
    if (wanted !== anyServerAllowsSignIn()) {
      const settings = getSettings();
      for (const kind of connectedServers()) {
        settings[kind].signIn = wanted;
      }
    }
  }
  deriveMediaServerLogin();
};

/** Turns sign-in with one connected server on or off, and saves. */
export const setSignIn = async (
  kind: MediaServerKind,
  signIn: boolean
): Promise<void> => {
  const settings = getSettings();
  if (!connectedServers().includes(kind)) {
    throw new MediaServerChangeError(
      404,
      `${serverName(kind)} is not connected.`
    );
  }
  // Someone has to be able to sign in: with a password, or another server.
  if (
    !signIn &&
    settings.main.localLogin === false &&
    !connectedServers().some(
      (other) => other !== kind && settings[other].signIn !== false
    )
  ) {
    throw new MediaServerChangeError(
      400,
      'At least one way to sign in must stay on. Turn on sign-in with a password, or with another server, first.'
    );
  }
  settings[kind].signIn = signIn;
  deriveMediaServerLogin();
  await settings.save();
};

/** Makes a connected server the primary one, and saves. */
export const makePrimary = async (kind: MediaServerKind): Promise<void> => {
  const settings = getSettings();
  if (!connectedServers().includes(kind)) {
    throw new MediaServerChangeError(
      404,
      `${serverName(kind)} is not connected.`
    );
  }
  settings.main.mediaServerType = typeOfKind(kind);
  await settings.save();
  logger.info(`${serverName(kind)} is now the primary media server`, {
    label: 'Media Servers',
  });
};

/**
 * Who removing this server would affect: people with an account on it and
 * none on another connected server that allows sign-in, nor a single
 * sign-on provider that is switched on. Their link stays, but is no longer
 * a way in; whoever has a password (and may use it) can still sign in with
 * that.
 */
export const removalImpact = async (
  kind: MediaServerKind
): Promise<MediaServerRemovalImpact> => {
  const settings = getSettings();
  const remaining = connectedServers().filter(
    (other) => other !== kind && settings[other].signIn !== false
  );
  const users = await getRepository(User)
    .createQueryBuilder('user')
    .select([
      'user.id',
      'user.plexId',
      'user.jellyfinUserId',
      'user.embyUserId',
    ])
    .addSelect('user.password')
    .where(`user.${USER_ID[kind]} IS NOT NULL`)
    .getMany();

  const impact: MediaServerRemovalImpact = { passwordOnly: 0, noSignIn: 0 };
  for (const user of users) {
    if (linkedServers(user).some((other) => remaining.includes(other))) {
      continue;
    }
    if ((await usableProviderLinks(user.id)).length) {
      continue;
    }
    // The owner may always use their password; others only while
    // sign-in with a password is on.
    const mayUsePassword =
      !!user.password && (user.id === 1 || settings.main.localLogin !== false);
    if (mayUsePassword) {
      impact.passwordOnly += 1;
    } else {
      impact.noSignIn += 1;
    }
  }
  return impact;
};

/**
 * Disconnects a server. Its address and libraries are kept for an easy
 * reconnect; a Jellyfin or Emby API key is forgotten. If it was the primary
 * one, the next connected server becomes primary. Titles lose its ids (its
 * next scan after reconnecting puts them back), and an availability sync
 * runs so nothing stays available only because of it. Its scans stop, its
 * Match Check findings go, and people's accounts on it are kept but no
 * longer used to sign in. The last connected server cannot be removed.
 */
export const removeServer = async (kind: MediaServerKind): Promise<void> => {
  const settings = getSettings();
  const servers = connectedServers();
  if (!servers.includes(kind)) {
    throw new MediaServerChangeError(
      404,
      `${serverName(kind)} is not connected.`
    );
  }
  const next = servers.find((other) => other !== kind);
  if (!next) {
    throw new MediaServerChangeError(
      400,
      'Seerr needs at least one media server. Connect another before removing this one.'
    );
  }

  if (primaryServer() === kind) {
    settings.main.mediaServerType = typeOfKind(next);
  }
  settings[kind].connected = false;
  if (isJellyfinFamily(kind)) {
    settings[kind].apiKey = '';
  }
  deriveMediaServerLogin();
  await settings.save();

  // Its scans stop first, so none of them puts back an id taken off below.
  refreshMediaServerJobs();

  // Only rows holding an id are touched, one column at a time, so the
  // other servers' ids on the same titles are left as they are.
  const media = getRepository(Media);
  for (const column of MEDIA_ID[kind]) {
    await media.update({ [column]: Not(IsNull()) }, { [column]: null });
  }
  await getRepository(MusicAlbum).update(
    { [MUSIC_ALBUM_ID[kind]]: Not(IsNull()) },
    { [MUSIC_ALBUM_ID[kind]]: null }
  );

  await plexMatchCheck.dropServer(serverName(kind) as MediaServerName);
  await matchWatch.dropServer(serverName(kind) as MediaServerName);

  // A sync already under way checked some titles with this server still
  // there; it runs once more when it finishes.
  availabilitySync.runSoon().catch((e) =>
    logger.error('Availability sync after removing a server failed', {
      label: 'Media Servers',
      errorMessage: e instanceof Error ? e.message : String(e),
    })
  );

  logger.info(`Disconnected from ${serverName(kind)}`, {
    label: 'Media Servers',
    primary: serverName(primaryServer() ?? next),
  });
};
