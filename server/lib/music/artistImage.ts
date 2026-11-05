import { albumCoverPath } from '@server/api/coverartarchive';
import { musicBrainz } from '@server/api/musicbrainz';
import type { LidarrImage } from '@server/api/servarr/lidarr';
import TheAudioDb, { THE_AUDIO_DB_FREE_KEY } from '@server/api/theaudiodb';
import { getRepository } from '@server/datasource';
import MusicMetadata from '@server/entity/MusicMetadata';
import { defaultLidarr, lidarrApi } from '@server/lib/music/access';
import type { ArtistImages, MusicImage } from '@server/lib/music/imageSources';
import {
  MUSIC_IMAGE_ORIGINS,
  musicImageFrom,
} from '@server/lib/music/imageSources';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

/*
 * Artist images, in order: Lidarr's lookup (fanart.tv and TheAudioDB, no key
 * needed), TheAudioDB (supporter key or the free one), then the newest
 * album's cover. Served via the image proxy, limited to ./imageSources.
 */

/** How long a result is cached before Lidarr is asked again. */
const KEPT_FOR_MS = 7 * 24 * 60 * 60 * 1000;

/** Image URL for the browser, through the proxy when caching is on. */
export const musicImageUrl = (image: MusicImage): string =>
  getSettings().main.cacheImages
    ? `/imageproxy/${image.source}${image.path}`
    : `${MUSIC_IMAGE_ORIGINS[image.source]}${image.path}`;

const fromLidarr = (images: LidarrImage[] = []): ArtistImages => {
  const find = (coverType: string) =>
    images
      .filter((image) => image.coverType?.toLowerCase() === coverType)
      .map((image) => musicImageFrom(image.remoteUrl ?? image.url))
      .find(Boolean) ?? null;
  return { photo: find('poster'), backdrop: find('fanart') };
};

const kept = async (key: string): Promise<ArtistImages | undefined> => {
  const row = await getRepository(MusicMetadata)
    .findOne({ where: { key } })
    .catch(() => null);
  if (!row || (row.expiresAt && new Date(row.expiresAt) <= new Date())) {
    return undefined;
  }
  try {
    return JSON.parse(row.data) as ArtistImages;
  } catch {
    return undefined;
  }
};

const keep = async (key: string, images: ArtistImages): Promise<void> => {
  const now = Date.now();
  await getRepository(MusicMetadata)
    .upsert(
      {
        key,
        data: JSON.stringify(images),
        fetchedAt: new Date(now),
        expiresAt: new Date(now + KEPT_FOR_MS),
      },
      ['key']
    )
    .catch((e) =>
      logger.debug('Could not keep an artist’s pictures', {
        label: 'Music',
        key,
        errorMessage: e instanceof Error ? e.message : String(e),
      })
    );
};

/** Cover of the newest album in the cached MusicBrainz list. */
const newestAlbumCover = async (
  artistMbid: string
): Promise<MusicImage | null> => {
  const albums = (await musicBrainz().keptArtistReleaseGroups(artistMbid))
    .filter(
      (group) =>
        group['primary-type'] === 'Album' &&
        !(group['secondary-types'] ?? []).length &&
        group['first-release-date']
    )
    .sort((a, b) =>
      (b['first-release-date'] ?? '').localeCompare(
        a['first-release-date'] ?? ''
      )
    );
  return albums[0]
    ? { source: 'caa', path: albumCoverPath(albums[0].id) }
    : null;
};

/**
 * The artist's images, cached for a week. Nothing is cached when Lidarr or
 * TheAudioDB fails, so the next visit retries.
 */
export const artistImages = async (
  artistMbid: string
): Promise<ArtistImages> => {
  const key = `artist-image:${artistMbid}`;
  let images = await kept(key);

  if (!images) {
    images = { photo: null, backdrop: null };
    let answered = true;
    const lidarr = defaultLidarr();
    if (lidarr) {
      try {
        const artist = await lidarrApi(lidarr).lookupArtist(artistMbid);
        images = fromLidarr(artist?.images);
      } catch (e) {
        answered = false;
        logger.debug('Lidarr could not look up an artist’s pictures', {
          label: 'Music',
          artistMbid,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
      }
    }

    const apiKey =
      getSettings().music.theAudioDbApiKey || THE_AUDIO_DB_FREE_KEY;
    if (!images.photo || !images.backdrop) {
      const tadb = await new TheAudioDb(apiKey).getArtistPictures(artistMbid);
      if (tadb) {
        images = {
          photo: images.photo ?? musicImageFrom(tadb.thumb),
          backdrop: images.backdrop ?? musicImageFrom(tadb.fanart),
        };
      } else {
        answered = false;
      }
    }

    if (answered) {
      await keep(key, images);
    }
  }

  return {
    ...images,
    photo: images.photo ?? (await newestAlbumCover(artistMbid)),
  };
};
