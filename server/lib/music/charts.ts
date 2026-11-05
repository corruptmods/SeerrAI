import type { AppleChartEntry } from '@server/api/applecharts';
import AppleChartsAPI from '@server/api/applecharts';
import { isMbid, musicBrainz } from '@server/api/musicbrainz';
import type {
  MbRecording,
  MbReleaseGroup,
} from '@server/api/musicbrainz/interfaces';
import { VARIOUS_ARTISTS_MBID } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import MusicMetadata from '@server/entity/MusicMetadata';
import type { Song, SongVersion } from '@server/lib/music/songs';
import {
  groupSongs,
  normalizeTitle,
  splitTitle,
} from '@server/lib/music/songs';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { In } from 'typeorm';

/*
 * Apple Music charts for the Top Songs, Trending, Top Albums and Top Artists
 * rows. Each entry is matched to MusicBrainz once (artist by name, then the
 * song or album) and cached for a month, so only new entries cost lookups.
 * Matching runs in MusicBrainz's background queue; rows fill in over time.
 */

const DAY = 24 * 60 * 60 * 1000;
/** Matches are cached a month; misses are retried after a day. */
const MATCH_KEPT = 30 * DAY;
const MISS_KEPT = DAY;
/** Max song age in days for Trending. */
export const TRENDING_DAYS = 30;

const LABEL = 'Music charts';

/** Album a chart entry matched. */
export interface ChartAlbum {
  id: string;
  title: string;
  primaryType?: string;
  secondaryTypes: string[];
  releaseDate?: string;
  artistId: string;
  artistName: string;
}

interface ChartArtist {
  id: string;
  name: string;
}

/** Chart country: Discover's region, else "us". */
export const chartCountry = (): string => {
  const region = getSettings().main.discoverRegion?.trim().toLowerCase();
  return region && /^[a-z]{2}$/.test(region) ? region : 'us';
};

// ---- keeping matches --------------------------------------------------------

/** In-process cache so a page of rows reads the database once. */
const memory = new Map<string, { data: unknown; expiresAt: number }>();

/**
 * Max matches in memory; the database keeps the rest. Playlists name
 * unbounded artists, so the oldest are evicted first.
 */
export const MOST_HELD = 2000;

const hold = (key: string, data: unknown, expiresAt: number): void => {
  memory.delete(key);
  memory.set(key, { data, expiresAt });
  if (memory.size > MOST_HELD) {
    memory.delete(memory.keys().next().value as string);
  }
};

/** Cached matches: the match, null for a miss, absent if not tried. */
const keptMany = async <T>(keys: string[]): Promise<Map<string, T | null>> => {
  const now = Date.now();
  const found = new Map<string, T | null>();
  const missing: string[] = [];
  for (const key of keys) {
    const held = memory.get(key);
    if (held && held.expiresAt > now) {
      found.set(key, held.data as T | null);
    } else {
      missing.push(key);
    }
  }
  if (missing.length) {
    const rows = await getRepository(MusicMetadata).find({
      where: { key: In(missing) },
    });
    for (const row of rows) {
      const expiresAt = row.expiresAt ? new Date(row.expiresAt).getTime() : 0;
      if (expiresAt > now) {
        const data = JSON.parse(row.data) as T | null;
        hold(row.key, data, expiresAt);
        found.set(row.key, data);
      }
    }
  }
  return found;
};

const keep = async (key: string, data: unknown): Promise<void> => {
  const expiresAt = Date.now() + (data === null ? MISS_KEPT : MATCH_KEPT);
  hold(key, data, expiresAt);
  await getRepository(MusicMetadata).upsert(
    {
      key,
      data: JSON.stringify(data),
      fetchedAt: new Date(),
      expiresAt: new Date(expiresAt),
    },
    ['key']
  );
};

// ---- matching ---------------------------------------------------------------

/** Normalises a name for comparison, ignoring punctuation. */
export const plainName = (name: string): string =>
  normalizeTitle(name)
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Strips credit brackets: "Song (feat. B)" and "Song (duet with B)". */
export const chartSongTitle = (name: string): string =>
  name
    .replace(
      /\s*[([](?:feat\.?|ft\.?|featuring|(?:duet\s+)?with)\s[^)\]]*[)\]]/gi,
      ''
    )
    .trim() || name;

/**
 * Strips Apple's " - EP" / " - Single" suffixes and edition brackets that
 * MusicBrainz files under the album itself.
 */
export const chartAlbumTitle = (name: string): string =>
  name
    .replace(/\s+-\s+(?:EP|Single)$/i, '')
    .replace(
      /\s*[([][^)\]]*\b(?:deluxe|expanded|anniversary|bonus|special|extended)\b[^)\]]*[)\]]\s*$/i,
      ''
    )
    .trim() || name;

/** Candidate album titles, Apple's own first. */
export const albumTitles = (name: string): string[] => {
  const title = chartAlbumTitle(name);
  const before = title.split(/\s*:\s+/)[0]?.trim();
  return [...new Set([title, before].filter(Boolean))] as string[];
};

/**
 * Candidate artist names, most likely first: the full credit ("A & B" may
 * be one act), then the first of several ("A, B & C", "A feat. B").
 */
export const creditedNames = (artistName: string): string[] => {
  const first = artistName
    .split(/\s*(?:,|&|\band\b|\bfeat\.?|\bft\.?|\bwith\b|\bx\b)\s*/i)[0]
    ?.trim();
  return [...new Set([artistName.trim(), first].filter(Boolean))] as string[];
};

const artistFor = async (artistName: string): Promise<ChartArtist | null> => {
  for (const name of creditedNames(artistName)) {
    const key = `chart-artist:${plainName(name)}`.slice(0, 100);
    const kept = (await keptMany<ChartArtist>([key])).get(key);
    if (kept !== undefined) {
      if (kept) return kept;
      continue;
    }
    const found = await musicBrainz().searchArtists(
      name,
      { limit: 10 },
      'background'
    );
    const wanted = plainName(name);
    const artist = (found.artists ?? []).find(
      (a) =>
        isMbid(a.id) &&
        a.id !== VARIOUS_ARTISTS_MBID &&
        (plainName(a.name) === wanted ||
          (a.aliases ?? []).some((alias) => plainName(alias.name) === wanted))
    );
    const match = artist ? { id: artist.id, name: artist.name } : null;
    await keep(key, match);
    if (match) return match;
  }
  return null;
};

/**
 * Finds a song by title and artist among the artist's MusicBrainz
 * recordings, or null. Uses the background queue, behind user requests.
 */
export const songNamed = async (
  name: string,
  artistName: string,
  /**
   * Version that will be requested; its recording is cached so the request
   * needs no second lookup. Defaults to the best known.
   */
  pick: (song: Song) => SongVersion | undefined = (song) => song.versions[0]
): Promise<Song | null> => {
  const artist = await artistFor(artistName);
  if (!artist) return null;
  const title = chartSongTitle(name);
  // Songs group under the title without version parts ("Song [Remix]" is
  // "Song"), so search that; the full title picks the version below.
  const { songTitle } = splitTitle(title);
  const wanted = plainName(songTitle);
  let song: Song | undefined;
  let recordings: MbRecording[] = [];
  // MusicBrainz search drops "&" but keeps "and": "A & B" is only found as
  // "A B", and vice versa.
  for (const phrase of [
    ...new Set([
      songTitle,
      songTitle.replace(/\s+(?:&|and)\s+/gi, ' '),
      songTitle.replace(/\s+&\s+/g, ' and '),
    ]),
  ]) {
    const found = await musicBrainz().searchRecordings(
      phrase,
      [artist.id],
      { limit: 50 },
      'background'
    );
    recordings = found.recordings ?? [];
    // Keep all versions: the one a playlist means may be obscure.
    song = groupSongs(recordings, songTitle, [artist.id], {
      songs: 5,
      versions: 50,
    }).find((s) => plainName(s.title) === wanted);
    if (song) break;
  }
  if (!song) return null;
  // Narrow to versions titled exactly as given, when only some are.
  const full = plainName(title);
  const named = song.versions.filter((v) => plainName(v.title) === full);
  const result =
    named.length && named.length < song.versions.length
      ? { ...song, versions: named }
      : song;
  const picked = pick(result);
  if (picked) {
    await musicBrainz().keepRecordings(
      recordings.filter((r) => r.id === picked.mbId)
    );
  }
  return result;
};

/**
 * Finds the artist's MusicBrainz recordings with this ISRC (the exact
 * take), or null. Uses the background queue, like songNamed.
 */
export const songByIsrc = async (
  isrc: string,
  artistName: string,
  pick: (song: Song) => SongVersion | undefined = (song) => song.versions[0]
): Promise<Song | null> => {
  const artist = await artistFor(artistName);
  if (!artist) return null;
  const found = await musicBrainz().searchRecordingsByIsrc(isrc, 'background');
  const recordings = found.recordings ?? [];
  const song = groupSongs(recordings, recordings[0]?.title ?? '', [artist.id], {
    songs: 1,
    versions: 25,
  })[0];
  if (!song) return null;
  const picked = pick(song);
  if (picked) {
    await musicBrainz().keepRecordings(
      recordings.filter((r) => r.id === picked.mbId)
    );
  }
  return song;
};

const matchSong = (entry: AppleChartEntry): Promise<Song | null> =>
  songNamed(entry.name, entry.artistName);

/** Rank for picking a chart album: plain albums and EPs first. */
const rank = (group: MbReleaseGroup): number =>
  (group['secondary-types']?.length ? 2 : 0) +
  (['Album', 'EP'].includes(group['primary-type'] ?? '') ? 0 : 1);

const matchAlbum = async (
  entry: AppleChartEntry
): Promise<ChartAlbum | null> => {
  const artist = await artistFor(entry.artistName);
  if (!artist) return null;
  let group: MbReleaseGroup | undefined;
  // Apple's colon editions ("Album: The Encore") fall back to the base
  // title, which MusicBrainz files them under.
  for (const title of albumTitles(entry.name)) {
    const found = await musicBrainz().searchReleaseGroupsBy(title, [artist.id]);
    const wanted = plainName(title);
    group = (found['release-groups'] ?? [])
      .filter((g) => isMbid(g.id) && plainName(g.title) === wanted)
      .sort((a, b) => rank(a) - rank(b))[0];
    if (group) break;
  }
  if (!group) return null;
  const credit = group['artist-credit'] ?? [];
  return {
    id: group.id,
    title: group.title,
    primaryType: group['primary-type'] ?? undefined,
    secondaryTypes: group['secondary-types'] ?? [],
    releaseDate: group['first-release-date'] || undefined,
    artistId: credit[0]?.artist?.id ?? artist.id,
    artistName:
      credit.map((c) => `${c.name}${c.joinphrase ?? ''}`).join('') ||
      artist.name,
  };
};

const songKey = (country: string, entry: AppleChartEntry) =>
  `chart-song:${country}:${entry.id}`;
const albumKey = (country: string, entry: AppleChartEntry) =>
  `chart-album:${country}:${entry.id}`;

/** In-flight matching per country; one run at a time. */
const filling = new Map<string, Promise<void>>();

/** Matches untried entries in chart order. */
const fill = (
  country: string,
  songs: AppleChartEntry[],
  albums: AppleChartEntry[]
): void => {
  if (filling.has(country)) return;
  const work = (async () => {
    const triedSongs = await keptMany<Song>(
      songs.map((e) => songKey(country, e))
    );
    const triedAlbums = await keptMany<ChartAlbum>(
      albums.map((e) => albumKey(country, e))
    );
    // Alternate songs and albums so neither row waits on the other.
    const todo: (() => Promise<void>)[] = [];
    const length = Math.max(songs.length, albums.length);
    for (let i = 0; i < length; i++) {
      const song = songs[i];
      if (song && !triedSongs.has(songKey(country, song))) {
        todo.push(async () =>
          keep(songKey(country, song), await matchSong(song))
        );
      }
      const album = albums[i];
      if (album && !triedAlbums.has(albumKey(country, album))) {
        todo.push(async () =>
          keep(albumKey(country, album), await matchAlbum(album))
        );
      }
    }
    for (const step of todo) {
      try {
        await step();
      } catch (e) {
        // Retried on the next visit (MusicBrainz busy, timeout).
        logger.debug('Could not match a chart entry to MusicBrainz', {
          label: LABEL,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
      }
    }
  })().finally(() => filling.delete(country));
  filling.set(country, work);
};

export interface ChartSong {
  entry: AppleChartEntry;
  song: Song;
}

export interface Charts {
  songs: ChartSong[];
  albums: ChartAlbum[];
}

/**
 * Matched chart entries in chart order; unmatched ones are matched in the
 * background for next time.
 */
export const charts = async (): Promise<Charts> => {
  const country = chartCountry();
  const api = new AppleChartsAPI();
  const [songs, albums] = await Promise.all([
    api.mostPlayed(country, 'songs'),
    api.mostPlayed(country, 'albums'),
  ]);
  const songMatches = await keptMany<Song>(
    songs.map((e) => songKey(country, e))
  );
  const albumMatches = await keptMany<ChartAlbum>(
    albums.map((e) => albumKey(country, e))
  );
  if (
    songs.some((e) => !songMatches.has(songKey(country, e))) ||
    albums.some((e) => !albumMatches.has(albumKey(country, e)))
  ) {
    fill(country, songs, albums);
  }
  const seenSongs = new Set<string>();
  const seenAlbums = new Set<string>();
  return {
    songs: songs.flatMap((entry) => {
      const song = songMatches.get(songKey(country, entry));
      if (!song || seenSongs.has(song.key)) return [];
      seenSongs.add(song.key);
      return [{ entry, song }];
    }),
    albums: albums.flatMap((entry) => {
      const album = albumMatches.get(albumKey(country, entry));
      if (!album || seenAlbums.has(album.id)) return [];
      seenAlbums.add(album.id);
      return [album];
    }),
  };
};

/** Chart songs released within TRENDING_DAYS, in chart order. */
export const trending = (songs: ChartSong[], now = Date.now()): ChartSong[] =>
  songs.filter(({ entry }) => {
    const out = Date.parse(entry.releaseDate ?? '');
    return Number.isFinite(out) && now - out <= TRENDING_DAYS * DAY;
  });

/** Chart artists in order of first appearance. */
export const chartArtists = ({ songs, albums }: Charts): ChartArtist[] => {
  const seen = new Set<string>();
  const artists: ChartArtist[] = [];
  for (const artist of [
    ...songs.map(({ song }) => ({
      id: song.artistMbid,
      name: song.artistName,
    })),
    ...albums.map((album) => ({ id: album.artistId, name: album.artistName })),
  ]) {
    if (isMbid(artist.id) && !seen.has(artist.id)) {
      seen.add(artist.id);
      artists.push(artist);
    }
  }
  return artists;
};

/** For tests: clears the in-memory cache. */
export const forgetChartMatches = () => {
  memory.clear();
};

/** For tests: in-memory cache size. */
export const chartMatchesHeld = (): number => memory.size;

/** For tests: resolves when in-flight matching finishes. */
export const chartsMatched = async (): Promise<void> => {
  await Promise.all(filling.values());
};
