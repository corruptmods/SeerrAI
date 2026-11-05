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
 * What Settings → Media Servers changes: connected servers, the primary, and
 * which allow sign-in.
 */

/** Why a media server change was refused, with the response status. */
export class MediaServerChangeError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/** Whether any connected server allows sign-in. */
const anyServerAllowsSignIn = (): boolean => {
  const settings = getSettings();
  return connectedServers().some((kind) => settings[kind].signIn !== false);
};

/**
 * Keeps the legacy sign-in switch (main.mediaServerLogin), still read by pages
 * and API clients, in step with the per-server ones: on while any connected
 * server allows sign-in. Left alone before any server is connected, as setup
 * reads it. The caller saves.
 */
export const deriveMediaServerLogin = (): void => {
  if (!connectedServers().length) return;
  getSettings().main.mediaServerLogin = anyServerAllowsSignIn();
};

/**
 * Settings → Users has one switch for all connected servers. Changing it sets
 * them all; saving it unchanged leaves each server's own. The caller saves.
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
  // Someone must still be able to sign in: by password or another server.
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

/** Makes a connected server primary, and saves. */
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
 * Who removing this server would affect: users with an account on it and none
 * on another sign-in-enabled connected server or enabled SSO provider. Their
 * link stays but no longer signs them in; anyone with a usable password can
 * still use it.
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
    // The owner can always use their password; others only while password
    // sign-in is on.
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
 * reconnect; a Jellyfin or Emby API key is discarded. If it was primary, the
 * next connected server becomes primary. Titles lose its ids (its next scan
 * after reconnecting restores them), and an availability sync runs so nothing
 * stays available only because of it. Its scans stop, its Match Check findings
 * are dropped, and users' accounts on it are kept but no longer sign them in.
 * The last connected server can't be removed.
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

  // Stop its scans first so none restores an id cleared below.
  refreshMediaServerJobs();

  // Only rows holding an id are touched, one column at a time, so other
  // servers' ids on the same titles are untouched.
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

  // A sync already running checked some titles while this server was still
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
