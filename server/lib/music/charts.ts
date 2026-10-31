import type { AppleChartEntry } from '@server/api/applecharts';
import AppleChartsAPI from '@server/api/applecharts';
import { isMbid, musicBrainz } from '@server/api/musicbrainz';
import type { MbReleaseGroup } from '@server/api/musicbrainz/interfaces';
import { VARIOUS_ARTISTS_MBID } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import MusicMetadata from '@server/entity/MusicMetadata';
import type { Song } from '@server/lib/music/songs';
import { groupSongs, normalizeTitle } from '@server/lib/music/songs';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { In } from 'typeorm';

/*
 * Apple Music's charts, as Music's Top Songs, Trending, Top Albums and Top
 * Artists rows. Apple names each song and album; each is matched once to
 * MusicBrainz (its artist by name, then the song or album among theirs),
 * and the match kept for a month, so only what is new on a chart costs a
 * lookup. Matching runs behind the scenes, in MusicBrainz's background
 * line: a chart's rows show what has been matched so far, and fill in.
 */

const DAY = 24 * 60 * 60 * 1000;
/** A match holds for a month; one not found is tried again the next day. */
const MATCH_KEPT = 30 * DAY;
const MISS_KEPT = DAY;
/** Songs out this recently are Trending. */
export const TRENDING_DAYS = 30;

const LABEL = 'Music charts';

/** An album a chart's entry was matched to. */
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

/** The charts' country: Discover's region, else the United States. */
export const chartCountry = (): string => {
  const region = getSettings().main.discoverRegion?.trim().toLowerCase();
  return region && /^[a-z]{2}$/.test(region) ? region : 'us';
};

// ---- keeping matches --------------------------------------------------------

/** Matches read this run, so a page of rows reads the database once. */
const memory = new Map<string, { data: unknown; expiresAt: number }>();

/**
 * The most matches held in memory; the database keeps the rest. Playlists
 * name artists without end, so the longest held are let go first.
 */
export const MOST_HELD = 2000;

const hold = (key: string, data: unknown, expiresAt: number): void => {
  memory.delete(key);
  memory.set(key, { data, expiresAt });
  if (memory.size > MOST_HELD) {
    memory.delete(memory.keys().next().value as string);
  }
};

/** A kept match: the match, null for none found, undefined if not tried. */
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

/** For comparing names: case, accents, quotes and punctuation aside. */
export const plainName = (name: string): string =>
  normalizeTitle(name)
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Apple's song title without what only credits someone: "Song (feat. B)"
 * is the song "Song".
 */
export const chartSongTitle = (name: string): string =>
  name
    .replace(/\s*[([](?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi, '')
    .trim() || name;

/**
 * Apple's album title without what Apple adds: "Album - EP", "Album -
 * Single", and editions MusicBrainz keeps under the album itself.
 */
export const chartAlbumTitle = (name: string): string =>
  name
    .replace(/\s+-\s+(?:EP|Single)$/i, '')
    .replace(
      /\s*[([][^)\]]*\b(?:deluxe|expanded|anniversary|bonus|special|extended)\b[^)\]]*[)\]]\s*$/i,
      ''
    )
    .trim() || name;

/** The titles an album may be under, as Apple names it first. */
export const albumTitles = (name: string): string[] => {
  const title = chartAlbumTitle(name);
  const before = title.split(/\s*:\s+/)[0]?.trim();
  return [...new Set([title, before].filter(Boolean))] as string[];
};

/**
 * Whom an entry is credited to, most likely first: as Apple writes it
 * ("Simon & Garfunkel" is one act), then the first of several ("A & B",
 * "A, B & C", "A feat. B").
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
 * A song named by its title and artist (as a chart or a playlist names
 * it), among the artist's recordings on MusicBrainz, or null. Background
 * work: it waits its turn behind what people are looking at.
 */
export const songNamed = async (
  name: string,
  artistName: string
): Promise<Song | null> => {
  const artist = await artistFor(artistName);
  if (!artist) return null;
  const title = chartSongTitle(name);
  const found = await musicBrainz().searchRecordings(
    title,
    [artist.id],
    { limit: 50 },
    'background'
  );
  const songs = groupSongs(found.recordings ?? [], title, [artist.id], {
    songs: 5,
    versions: 5,
  });
  const wanted = plainName(title);
  return songs.find((song) => plainName(song.title) === wanted) ?? null;
};

/** The song on a chart, among its artist's recordings. */
const matchSong = (entry: AppleChartEntry): Promise<Song | null> =>
  songNamed(entry.name, entry.artistName);

/** Which of an artist's albums is a chart's: its own albums before others. */
const rank = (group: MbReleaseGroup): number =>
  (group['secondary-types']?.length ? 2 : 0) +
  (['Album', 'EP'].includes(group['primary-type'] ?? '') ? 0 : 1);

const matchAlbum = async (
  entry: AppleChartEntry
): Promise<ChartAlbum | null> => {
  const artist = await artistFor(entry.artistName);
  if (!artist) return null;
  let group: MbReleaseGroup | undefined;
  // An edition Apple names after a colon ("Album: The Encore") is kept
  // under the album itself when MusicBrainz has it on its own.
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

/** Matching under way, by country: one at a time. */
const filling = new Map<string, Promise<void>>();

/** Matches what has not been tried yet, in chart order. */
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
    // Alternating, so neither row waits for the other to be done.
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
        // Tried again on the next visit: MusicBrainz busy, a timeout.
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
 * The charts, as far as they are matched, in chart order; what is not yet
 * is matched behind the scenes, for next time.
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

/** Songs on the chart that came out lately, highest first. */
export const trending = (songs: ChartSong[], now = Date.now()): ChartSong[] =>
  songs.filter(({ entry }) => {
    const out = Date.parse(entry.releaseDate ?? '');
    return Number.isFinite(out) && now - out <= TRENDING_DAYS * DAY;
  });

/** The artists of the charts, in the order they first appear. */
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

/** For tests: forget what this run has read. */
export const forgetChartMatches = () => {
  memory.clear();
};

/** For tests: how many matches are held in memory. */
export const chartMatchesHeld = (): number => memory.size;

/** For tests: once matching under way is done. */
export const chartsMatched = async (): Promise<void> => {
  await Promise.all(filling.values());
};
