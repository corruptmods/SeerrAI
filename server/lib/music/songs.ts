import type {
  MbRecording,
  MbRecordingRelease,
} from '@server/api/musicbrainz/interfaces';

/*
 * Songs, from MusicBrainz's recordings. A recording is one version of a
 * song: the album take, the radio edit and the club mix of one song are
 * three recordings, often on different releases (a single carries its own
 * edit, not the album's take). So a song is shown as its versions, each
 * named from what MusicBrainz says of it, and asked for on its own.
 *
 * Nothing here asks MusicBrainz or the database.
 */

/** A version of a song as it is shown and asked for. */
export interface SongVersion {
  /** The recording's MusicBrainz id. */
  mbId: string;
  /** The recording's title as MusicBrainz has it. */
  title: string;
  /** The song's title, without what names the version. */
  songTitle: string;
  /** What tells it apart ("radio edit", "club mix"), when anything does. */
  version: string | null;
  /** Milliseconds. */
  length: number | null;
  /** The first credited artist, whom the song belongs to here. */
  artistMbid: string;
  /** Everyone credited, as MusicBrainz writes it ("A feat. B"). */
  artistName: string;
  /** The album or single it is best known from. */
  from: SongRelease | null;
  /** Every album and single it is on, best known first. */
  releaseGroups: SongRelease[];
  /** How many releases it is on: the more, the better known. */
  releaseCount: number;
}

/** An album or single a song is on. */
export interface SongRelease {
  /** Its MusicBrainz release-group id. */
  mbId: string;
  title: string;
  primaryType: string | null;
  secondaryTypes: string[];
  /** Its earliest release with this song on it. */
  date: string | null;
}

/** A song: its versions by one artist under one title. */
export interface Song {
  /** The artist's id and the song's title, as one key. */
  key: string;
  title: string;
  artistMbid: string;
  artistName: string;
  /** Best known first. */
  versions: SongVersion[];
}

/** Releases not to be counted or fetched from: unofficial copies. */
const UNUSABLE_STATUS = new Set(['bootleg', 'pseudo-release']);

/**
 * A recording that is only part of a continuous DJ mix ("part of … DJ-mix")
 * is cut from the mix, not a version anyone can fetch on its own.
 */
const MIX_ONLY = 'DJ-mix';

/** What a version is named by in a title's " - …" tail. */
const VERSION_WORDS =
  /\b(edit|mix|remix|version|live|remaster(ed)?|acoustic|demo|instrumental|radio|extended|dub|mono|stereo|session|unplugged|rework|cut)\b/i;

/** Every bracketed part at the end of a title: "X (radio edit) [live]". */
const TRAILING_BRACKETS = /\s*[([]([^()[\]]+)[)\]]\s*$/;

/** A title's "Song - Radio Edit" tail, when it names a version. */
const DASH_TAIL = /\s+[-–—]\s+([^-–—]+)$/;

/**
 * A recording's title split into the song's own and what names the
 * version: "Song (radio edit)", "Song [Club Mix]", "Song - Live".
 */
export const splitTitle = (
  title: string
): { songTitle: string; parts: string[] } => {
  let rest = title.trim();
  const parts: string[] = [];
  for (;;) {
    const bracket = rest.match(TRAILING_BRACKETS);
    if (bracket && bracket.index && bracket.index > 0) {
      parts.unshift(bracket[1].trim());
      rest = rest.slice(0, bracket.index).trim();
      continue;
    }
    const dash = rest.match(DASH_TAIL);
    if (dash && dash.index && dash.index > 0 && VERSION_WORDS.test(dash[1])) {
      parts.unshift(dash[1].trim());
      rest = rest.slice(0, dash.index).trim();
      continue;
    }
    break;
  }
  return { songTitle: rest || title.trim(), parts };
};

/**
 * What tells a version apart: the parts of its title that name it, and
 * MusicBrainz's note on it ("radio edit", "live, 2013-05-31: …"). None
 * for a version with neither, which is shown by its release and length.
 */
export const versionLabel = (recording: MbRecording): string | null => {
  const { parts } = splitTitle(recording.title);
  const note = recording.disambiguation?.trim();
  const all = [...parts];
  if (note && !all.some((part) => part.toLowerCase() === note.toLowerCase())) {
    all.push(note);
  }
  return all.length ? all.join(' · ') : null;
};

/** A title as compared: case, accents, quotes and spacing aside. */
export const normalizeTitle = (title: string): string =>
  title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑‒–—]/g, '-')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const usable = (release: MbRecordingRelease): boolean =>
  !!release['release-group']?.id &&
  !UNUSABLE_STATUS.has((release.status ?? '').toLowerCase());

/**
 * How well an album or single stands for a song: the artist's own album
 * first, then their single or EP, then anything else (a soundtrack, a live
 * album, a compilation), compilations last.
 */
const standing = (group: SongRelease): number => {
  const secondary = group.secondaryTypes;
  if (!secondary.length) {
    switch (group.primaryType) {
      case 'Album':
        return 0;
      case 'Single':
        return 1;
      case 'EP':
        return 2;
      default:
        return 3;
    }
  }
  return secondary.includes('Compilation') ? 5 : 4;
};

const byStanding = (a: SongRelease, b: SongRelease): number =>
  standing(a) - standing(b) ||
  (a.date || '9999').localeCompare(b.date || '9999') ||
  a.title.localeCompare(b.title);

/**
 * A recording as a version of a song, or null for one nobody can ask for:
 * a video, or one on no release but unofficial copies and DJ mixes.
 */
export const toVersion = (recording: MbRecording): SongVersion | null => {
  const credits = recording['artist-credit'] ?? [];
  if (recording.video || !credits.length) {
    return null;
  }
  const releases = (recording.releases ?? []).filter(usable);
  const groups = new Map<string, SongRelease>();
  for (const release of releases) {
    const group = release['release-group'];
    if (!group) {
      continue;
    }
    const date = release.date || null;
    const known = groups.get(group.id);
    if (known) {
      if (date && (!known.date || date < known.date)) {
        known.date = date;
      }
      continue;
    }
    groups.set(group.id, {
      mbId: group.id,
      title: group.title,
      primaryType: group['primary-type'] ?? null,
      secondaryTypes: group['secondary-types'] ?? [],
      date,
    });
  }
  const releaseGroups = [...groups.values()].sort(byStanding);
  if (
    !releaseGroups.length ||
    releaseGroups.every((group) => group.secondaryTypes.includes(MIX_ONLY))
  ) {
    return null;
  }

  return {
    mbId: recording.id,
    title: recording.title,
    songTitle: splitTitle(recording.title).songTitle,
    version: versionLabel(recording),
    length: recording.length ?? null,
    artistMbid: credits[0].artist.id,
    artistName: credits
      .map((credit) => `${credit.name}${credit.joinphrase ?? ''}`)
      .join('')
      .trim(),
    from: releaseGroups[0],
    releaseGroups,
    releaseCount: releases.length,
  };
};

/**
 * Recordings found for what was typed, as songs: each artist's versions
 * of one title together, best known first. Only the artists given count
 * (a mash-up credits others first). A song titled as typed comes before
 * one that only holds it ("Song Medley"), then the artists in the order
 * given.
 */
export const groupSongs = (
  recordings: MbRecording[],
  query: string,
  artistOrder: string[],
  { songs = 8, versions = 25 }: { songs?: number; versions?: number } = {}
): Song[] => {
  const typed = normalizeTitle(query);
  const byKey = new Map<string, Song>();
  for (const recording of recordings) {
    const version = toVersion(recording);
    if (!version || !artistOrder.includes(version.artistMbid)) {
      continue;
    }
    const key = `${version.artistMbid}:${normalizeTitle(version.songTitle)}`;
    const song = byKey.get(key);
    if (song) {
      song.versions.push(version);
    } else {
      byKey.set(key, {
        key,
        title: version.songTitle,
        artistMbid: version.artistMbid,
        artistName: version.artistName,
        versions: [version],
      });
    }
  }

  const known = (song: Song) =>
    song.versions.reduce((sum, version) => sum + version.releaseCount, 0);
  const ranked = [...byKey.values()]
    .map((song) => {
      song.versions.sort(
        (a, b) =>
          b.releaseCount - a.releaseCount ||
          Number(!!a.version) - Number(!!b.version) ||
          a.mbId.localeCompare(b.mbId)
      );
      // Named for its best-known version, and credited as it is.
      song.title = song.versions[0].songTitle;
      song.artistName = song.versions[0].artistName;
      song.versions = song.versions.slice(0, versions);
      return song;
    })
    .sort(
      (a, b) =>
        Number(normalizeTitle(b.title) === typed) -
          Number(normalizeTitle(a.title) === typed) ||
        artistOrder.indexOf(a.artistMbid) - artistOrder.indexOf(b.artistMbid) ||
        known(b) - known(a)
    );

  return ranked.slice(0, songs);
};
