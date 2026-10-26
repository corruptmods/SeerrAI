import { albumCoverUrl } from '@server/api/coverartarchive';
import ListenBrainzAPI, {
  LISTENBRAINZ_LABS_URL,
} from '@server/api/listenbrainz';
import { isMbid, musicBrainz } from '@server/api/musicbrainz';
import {
  MediaRequestStatus,
  MediaType,
  VARIOUS_ARTISTS_MBID,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import { albumStatuses, artistStatuses } from '@server/lib/music/library';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { MusicAlbumResult, MusicArtistResult } from '@server/models/Music';
import { Not } from 'typeorm';

/*
 * Rows of the Music page that are each person's own, from the music they
 * have asked for: what they asked for, more by those artists, and artists
 * like them. Only their own requests are read, so no one sees another's
 * taste. A row is empty for someone who has asked for no music.
 */

/** Requests read for a person's rows: plenty, newest first. */
const REQUESTS_READ = 200;
/** Artists whose other albums are shown, the most recently asked first. */
const ARTISTS_FOR_MORE = 10;
/** Artists ListenBrainz is asked about, one call each. */
const ARTISTS_FOR_LIKE = 5;
/** The most a row lists. */
const ROW_MOST = 60;

interface Asked {
  /** Release groups asked for, or that a song asked for is on. */
  albums: MusicAlbumResult[];
  /** The artists, newest asked first. */
  artists: { id: string; name: string }[];
}

/** What a person has asked for, newest first, declined requests aside. */
const askedBy = async (userId: number): Promise<Asked> => {
  const requests = await getRepository(MediaRequest).find({
    where: {
      type: MediaType.MUSIC,
      requestedBy: { id: userId },
      status: Not(MediaRequestStatus.DECLINED),
    },
    relations: { media: true },
    order: { createdAt: 'DESC', id: 'DESC' },
    take: REQUESTS_READ,
  });
  const albums = new Map<string, MusicAlbumResult>();
  const artists = new Map<string, string>();
  for (const request of requests) {
    const artistId = request.media?.foreignId ?? undefined;
    const artistName = request.media?.foreignTitle ?? undefined;
    if (artistId && isMbid(artistId) && artistId !== VARIOUS_ARTISTS_MBID) {
      if (!artists.has(artistId)) artists.set(artistId, artistName ?? '');
    }
    const add = (id: string | null | undefined, title: string | null) => {
      if (!id || !isMbid(id) || albums.has(id)) return;
      albums.set(id, {
        mediaType: 'album',
        id,
        title: title ?? '',
        secondaryTypes: [],
        artistId,
        artistName,
        coverUrl: albumCoverUrl(id),
      });
    };
    for (const album of request.albums ?? []) {
      if (album.status !== MediaRequestStatus.DECLINED) {
        add(album.albumMbid, album.title);
      }
    }
    for (const song of request.songs ?? []) {
      if (song.status !== MediaRequestStatus.DECLINED) {
        add(song.albumMbid, song.albumTitle);
      }
    }
  }
  return {
    albums: [...albums.values()],
    artists: [...artists].map(([id, name]) => ({ id, name })),
  };
};

/** The albums a person asked for (and those their songs are on). */
export const yourMusicRequests = async (
  userId: number
): Promise<MusicAlbumResult[]> => {
  const { albums } = await askedBy(userId);
  const statuses = await albumStatuses(albums.map((album) => album.id));
  return albums
    .slice(0, ROW_MOST)
    .map((album) => ({ ...album, status: statuses.get(album.id) }));
};

/**
 * Their artists' other studio albums and EPs, newest first. From the
 * albums MusicBrainz has already listed for each (as the artist's page
 * asks); an artist not listed yet is asked for in the background, and
 * shows here next time, so the page never waits on MusicBrainz.
 */
export const moreFromYourArtists = async (
  userId: number
): Promise<MusicAlbumResult[]> => {
  const { albums, artists } = await askedBy(userId);
  const asked = new Set(albums.map((album) => album.id));
  const mb = musicBrainz();
  const found: MusicAlbumResult[] = [];
  const seen = new Set<string>();
  for (const artist of artists.slice(0, ARTISTS_FOR_MORE)) {
    const groups = await mb.keptArtistReleaseGroups(artist.id);
    if (!groups.length) {
      mb.getArtistReleaseGroups(artist.id, {}, 'background').catch((e) =>
        logger.debug('Could not list an artist’s albums for their row', {
          label: 'Music',
          artist: artist.id,
          errorMessage: e instanceof Error ? e.message : String(e),
        })
      );
      continue;
    }
    for (const group of groups) {
      if (
        asked.has(group.id) ||
        seen.has(group.id) ||
        !['Album', 'EP'].includes(group['primary-type'] ?? '') ||
        (group['secondary-types'] ?? []).length > 0 ||
        !group['first-release-date']
      ) {
        continue;
      }
      seen.add(group.id);
      found.push({
        mediaType: 'album',
        id: group.id,
        title: group.title,
        primaryType: group['primary-type'] ?? undefined,
        secondaryTypes: [],
        releaseDate: group['first-release-date'],
        artistId: artist.id,
        artistName: artist.name || undefined,
        coverUrl: albumCoverUrl(group.id),
      });
    }
  }
  found.sort((a, b) =>
    (b.releaseDate ?? '').localeCompare(a.releaseDate ?? '')
  );
  const shown = found.slice(0, ROW_MOST);
  const statuses = await albumStatuses(shown.map((album) => album.id));
  return shown.map((album) => ({ ...album, status: statuses.get(album.id) }));
};

/**
 * Artists people listen to alongside theirs, from ListenBrainz (off with
 * its rows, under Settings → Music). Each artist's list is weighed on its
 * own, so one artist with many does not crowd out the rest; artists they
 * have already asked for are left out.
 */
export const artistsLikeYours = async (
  userId: number
): Promise<MusicArtistResult[]> => {
  if (!getSettings().music.listenBrainz) return [];
  const { artists } = await askedBy(userId);
  if (!artists.length) return [];
  const theirs = new Set(artists.map((artist) => artist.id));
  const lb = new ListenBrainzAPI(LISTENBRAINZ_LABS_URL);
  const lists = await Promise.allSettled(
    artists
      .slice(0, ARTISTS_FOR_LIKE)
      .map((artist) => lb.getSimilarArtists(artist.id))
  );
  const like = new Map<string, { artist: MusicArtistResult; weight: number }>();
  for (const list of lists) {
    if (list.status !== 'fulfilled' || !Array.isArray(list.value)) continue;
    const top = Math.max(1, ...list.value.map((a) => a.score ?? 0));
    for (const similar of list.value) {
      if (!isMbid(similar.artist_mbid) || theirs.has(similar.artist_mbid)) {
        continue;
      }
      const weight = (similar.score ?? 0) / top;
      const known = like.get(similar.artist_mbid);
      if (known) {
        known.weight += weight;
      } else {
        like.set(similar.artist_mbid, {
          weight,
          artist: {
            mediaType: 'artist',
            id: similar.artist_mbid,
            name: similar.name,
            disambiguation: similar.comment || undefined,
            type: similar.type ?? undefined,
          },
        });
      }
    }
  }
  const shown = [...like.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, ROW_MOST)
    .map((entry) => entry.artist);
  const statuses = await artistStatuses(shown.map((artist) => artist.id));
  return shown.map((artist) => ({
    ...artist,
    status: statuses.get(artist.id),
  }));
};
