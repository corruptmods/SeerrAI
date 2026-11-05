import type { JellyfinFamilyKind } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import ImageProxy, {
  etagMatches,
  PICTURE_HEADERS,
} from '@server/lib/imageproxy';
import {
  connectedServers,
  hostnameFor,
  isJellyfinFamily,
  jellyfinFamilyServer,
  USER_ID,
} from '@server/lib/mediaServers';
import logger from '@server/logger';
import axios from 'axios';
import type { Request, Response } from 'express';
import { Router } from 'express';
import gravatarUrl from 'gravatar-url';
import { createHash } from 'node:crypto';

const router = Router();

let _avatarImageProxy: ImageProxy | null = null;

function initAvatarImageProxy() {
  if (!_avatarImageProxy) {
    _avatarImageProxy = new ImageProxy('avatar', '');
  }
  return _avatarImageProxy;
}

function getJellyfinAvatarUrl(userId: string, kind: JellyfinFamilyKind) {
  return kind === 'jellyfin'
    ? `${hostnameFor(kind)}/UserImage?UserId=${userId}`
    : `${hostnameFor(kind)}/Users/${userId}/Images/Primary?quality=90`;
}

/**
 * The Jellyfin or Emby server a person's avatar comes from: a connected one
 * they have an account on (primary first), else any they have an account on.
 */
const avatarServerOf = (
  user: Pick<User, 'jellyfinUserId' | 'embyUserId'>
): JellyfinFamilyKind | undefined => {
  const linked = (['jellyfin', 'emby'] as const).filter(
    (kind) => !!user[USER_ID[kind]]
  );
  return (
    connectedServers()
      .filter(isJellyfinFamily)
      .find((kind) => linked.includes(kind)) ?? linked[0]
  );
};

function computeImageHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function checkAvatarChanged(
  user: User,
  server?: JellyfinFamilyKind
): Promise<{ changed: boolean; etag?: string }> {
  try {
    const kind = user ? (server ?? avatarServerOf(user)) : undefined;
    const accountId = kind ? user[USER_ID[kind]] : undefined;
    if (!kind || !accountId) {
      return { changed: false };
    }

    const jellyfinAvatarUrl = getJellyfinAvatarUrl(accountId, kind);

    let headResponse;
    try {
      headResponse = await axios.head(jellyfinAvatarUrl, { timeout: 5000 });
      if (headResponse.status !== 200) {
        return { changed: false };
      }
    } catch {
      return { changed: false };
    }

    // Jellyfin dates its pictures, Emby tags them.
    let remoteVersion: string;
    if (kind === 'jellyfin') {
      const remoteLastModifiedStr = headResponse.headers['last-modified'] || '';
      remoteVersion = (
        Date.parse(remoteLastModifiedStr) || Date.now()
      ).toString();
    } else {
      remoteVersion =
        headResponse.headers['etag']?.replace(/"/g, '') ||
        Date.now().toString();
    }

    if (user.avatarVersion && user.avatarVersion === remoteVersion) {
      return { changed: false, etag: user.avatarETag ?? undefined };
    }

    const avatarImageCache = initAvatarImageProxy();
    await avatarImageCache.clearCachedImage(jellyfinAvatarUrl);
    const imageData = await avatarImageCache.getImage(
      jellyfinAvatarUrl,
      gravatarUrl(user.email || 'none', { default: 'mm', size: 200 })
    );

    const newHash = computeImageHash(imageData.imageBuffer);

    const hasChanged = user.avatarETag !== newHash;

    user.avatarVersion = remoteVersion;
    if (hasChanged) {
      user.avatarETag = newHash;
    }

    await getRepository(User).save(user);

    return { changed: hasChanged, etag: newHash };
  } catch (error) {
    logger.error('Error checking avatar changes', {
      errorMessage: error.message,
    });
    return { changed: false };
  }
}

/** Send a cached avatar, or 304 if the browser's copy is current. */
const sendPicture = (
  req: Request,
  res: Response,
  imageData: Awaited<ReturnType<ImageProxy['getImage']>>
) => {
  // A host without its own ETag (Jellyfin) would give every avatar the same
  // empty one, so revalidation would always say unchanged; use the picture's
  // hash.
  const etag = `"${
    imageData.meta.etag || computeImageHash(imageData.imageBuffer)
  }"`;
  const headers = {
    'Cache-Control': `public, max-age=${imageData.meta.curRevalidate}`,
    ETag: etag,
  };

  if (etagMatches(req.headers['if-none-match'], etag) && !req.query.v) {
    res.writeHead(304, headers);
    return res.end();
  }

  res.writeHead(200, {
    ...headers,
    ...PICTURE_HEADERS,
    'Content-Type': imageData.meta.contentType,
    'Content-Length': imageData.imageBuffer.length,
    'OS-Cache-Key': imageData.meta.cacheKey,
    'OS-Cache-Status': imageData.meta.cacheMiss ? 'MISS' : 'HIT',
  });
  res.end(imageData.imageBuffer);
};

/**
 * Fallback when neither the picture nor the stand-in can be fetched: a plain
 * silhouette, cached only a few minutes so the real picture is retried soon.
 */
const SILHOUETTE = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#4b5563"/><circle cx="32" cy="25" r="11" fill="#9ca3af"/><path d="M12 56c2-11 10-17 20-17s18 6 20 17z" fill="#9ca3af"/></svg>'
);
const sendSilhouette = (res: Response) => {
  res.writeHead(200, {
    ...PICTURE_HEADERS,
    'Cache-Control': 'public, max-age=300',
    'Content-Type': 'image/svg+xml',
    'Content-Length': SILHOUETTE.length,
  });
  res.end(SILHOUETTE);
};

/** Plex account picture URL, capturing its id. */
export const PLEX_AVATAR =
  /^https:\/\/plex\.tv\/users\/([0-9a-f]{8,64})\/avatar(?:\?.*)?$/;

/**
 * A Plex account's picture, cached here so pages don't depend on plex.tv, which
 * is unreliable. Only fetched for users with an account here, at the URL Plex
 * gave them; when plex.tv is unreachable a stand-in is sent.
 */
router.get('/plex/:plexAvatarId', async (req, res, next) => {
  const avatarId = req.params.plexAvatarId;
  if (!/^[0-9a-f]{8,64}$/.test(avatarId)) {
    return next({ status: 400, message: 'Provided URL is not a Plex avatar.' });
  }
  try {
    const user = await getRepository(User)
      .createQueryBuilder('user')
      .select(['user.id', 'user.email', 'user.avatar'])
      .where('user.avatar LIKE :address', {
        address: `https://plex.tv/users/${avatarId}/avatar%`,
      })
      .getOne();
    if (!user || !PLEX_AVATAR.test(user.avatar)) {
      return next({ status: 404, message: 'No such avatar.' });
    }
    const avatarImageCache = initAvatarImageProxy();
    const fallbackUrl = gravatarUrl(user.email || 'none', {
      default: 'mm',
      size: 200,
    });
    let imageData = await avatarImageCache.getImage(user.avatar, fallbackUrl);
    if (imageData.meta.extension === 'json') {
      imageData = await avatarImageCache.getImage(fallbackUrl);
    }
    return sendPicture(req, res, imageData);
  } catch (e) {
    logger.warn('Could not fetch a Plex avatar', { errorMessage: e.message });
    if (!res.headersSent) {
      return sendSilhouette(res);
    }
    next(e);
  }
});

/**
 * A Jellyfin or Emby account's picture by account id. The server is the one
 * whose column holds the id (stored avatar URLs carry only the id);
 * `?server=jellyfin|emby` picks it for an id no user has yet.
 */
router.get('/:jellyfinUserId', async (req, res, next) => {
  const hint =
    req.query.server === 'jellyfin' || req.query.server === 'emby'
      ? req.query.server
      : undefined;
  if (!req.params.jellyfinUserId.match(/^[a-f0-9]{32}$/)) {
    const kind = hint ?? jellyfinFamilyServer();
    return next({
      status: 400,
      message: `Provided URL is not ${
        kind === 'jellyfin' ? 'a Jellyfin' : 'an Emby'
      } avatar.`,
    });
  }
  try {
    const avatarImageCache = initAvatarImageProxy();

    const accountId = req.params.jellyfinUserId;

    const users = await getRepository(User).find({
      where: [{ jellyfinUserId: accountId }, { embyUserId: accountId }],
    });
    const owner = (kind: JellyfinFamilyKind) =>
      users.find((u) => u[USER_ID[kind]] === accountId);
    const kind: JellyfinFamilyKind =
      (hint && owner(hint) ? hint : undefined) ??
      (owner('jellyfin') ? 'jellyfin' : undefined) ??
      (owner('emby') ? 'emby' : undefined) ??
      hint ??
      jellyfinFamilyServer() ??
      'jellyfin';
    const user = owner(kind);

    const fallbackUrl = gravatarUrl(user?.email || 'none', {
      default: 'mm',
      size: 200,
    });

    const jellyfinAvatarUrl = getJellyfinAvatarUrl(accountId, kind);

    let imageData;
    if (user?.avatarVersion) {
      imageData = await avatarImageCache.getImage(
        jellyfinAvatarUrl,
        fallbackUrl
      );
      if (imageData.meta.extension === 'json') {
        imageData = await avatarImageCache.getImage(fallbackUrl);
      }
    } else {
      imageData = await avatarImageCache.getImage(fallbackUrl);
    }

    return sendPicture(req, res, imageData);
  } catch (e) {
    logger.error('Failed to proxy avatar image', { errorMessage: e.message });
    if (!res.headersSent) {
      return next({
        status: 500,
        message: 'Failed to proxy avatar image.',
      });
    }
    next(e);
  }
});

export default router;
