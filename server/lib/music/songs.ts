import type {
  MbRecording,
  MbRecordingRelease,
} from '@server/api/musicbrainz/interfaces';

/*
 * Songs from MusicBrainz recordings. Each recording is one version (album
 * take, radio edit, club mix), often on different releases, so a song is
 * shown and requested per version. Pure: no MusicBrainz or database calls.
 */

/** A song version as shown and requested. */
export interface SongVersion {
  /** Recording MusicBrainz id. */
  mbId: string;
  /** Recording title as MusicBrainz has it. */
  title: string;
  /** Title without the version part. */
  songTitle: string;
  /** Version label ("radio edit", "club mix"), if any. */
  version: string | null;
  /** Milliseconds. */
  length: number | null;
  /** First credited artist, who owns the song here. */
  artistMbid: string;
  /** Full credit as MusicBrainz writes it ("A feat. B"). */
  artistName: string;
  /** Album or single it's best known from. */
  from: SongRelease | null;
  /** Every album and single it's on, best known first. */
  releaseGroups: SongRelease[];
  /** Number of releases it's on; a popularity signal. */
  releaseCount: number;
}

/** An album or single a song is on. */
export interface SongRelease {
  /** MusicBrainz release-group id. */
  mbId: string;
  title: string;
  primaryType: string | null;
  secondaryTypes: string[];
  /** Earliest release date with this song. */
  date: string | null;
  /**
   * A release credits the song's artist (or credits no one), so it's theirs
   * rather than someone else's compilation.
   */
  byArtist: boolean;
}

/** A song: one artist's versions under one title. */
export interface Song {
  /** Artist id plus normalised title. */
  key: string;
  title: string;
  artistMbid: string;
  artistName: string;
  /** Best known first. */
  versions: SongVersion[];
}

/** Unofficial release statuses, never counted or fetched. */
const UNUSABLE_STATUS = new Set(['bootleg', 'pseudo-release']);

/** Recordings only on DJ mixes are cuts and can't be fetched alone. */
const MIX_ONLY = 'DJ-mix';

/** Words that mark a " - …" title tail as a version. */
const VERSION_WORDS =
  /\b(edit|mix|remix|version|live|remaster(ed)?|acoustic|demo|instrumental|radio|extended|dub|mono|stereo|session|unplugged|rework|cut)\b/i;

/** One trailing bracketed part: "X (radio edit) [live]". */
const TRAILING_BRACKETS = /\s*[([]([^()[\]]+)[)\]]\s*$/;

/** A "Song - Radio Edit" dash tail. */
const DASH_TAIL = /\s+[-–—]\s+([^-–—]+)$/;

/**
 * Splits a title into the song title and version parts: "Song (radio
 * edit)", "Song [Club Mix]", "Song - Live".
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
 * Version label from title parts plus MusicBrainz's disambiguation ("live,
 * 2013-05-31: …"). Null when neither exists.
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

/** Normalises case, accents, quotes, dashes and spacing for comparison. */
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

/**
 * Regex source for words marking a different take (live, acoustic, remix,
 * instrumental, karaoke, demo, re-recording, sped up, Atmos…). Radio edits,
 * single versions and remasters are the same take. Matches `takeWords`
 * output: lowercase, punctuation as spaces, apostrophes as a space or
 * dropped ("artist s version" / "artists version").
 */
export const OTHER_TAKE_WORDS = String.raw`live|acoustic|unplugged|piano|sessions?|orchestral|lullaby|remix|remixes|remixed|(?:club|extended|dub) mix|(?<!(?:radio|single|album|original|main|mono|stereo) )mix(?:es)?|instrumentals?|karaoke|a cappella|acapella|tribute|bootlegs?|mash ?ups?|reworks?|reworked|clean|censored|demos?|outtakes?|rehearsal|re recorded|rerecorded|(?!(?:this|his|its|hers|bonus|plus)\b)\w+(?: s|s) version|sped up|slowed|nightcore|8 bit|alternate (?:take|version|mix)|take \d+|dolby atmos|atmos|360 reality audio|spatial audio|binaural|surround`;

const OTHER_TAKES = new RegExp(String.raw`\b(?:${OTHER_TAKE_WORDS})\b`, 'g');

/** Normalised words only: punctuation and brackets become spaces. */
export const takeWords = (text: string): string =>
  normalizeTitle(text)
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * True when `name` has a take word `title` lacks ("Song (acoustic)" vs
 * "Song"; not vs "Song (Acoustic)").
 */
export const otherTake = (name: string, title: string): boolean => {
  const own = new Set(takeWords(title).match(OTHER_TAKES) ?? []);
  return (takeWords(name).match(OTHER_TAKES) ?? []).some((w) => !own.has(w));
};

const usable = (release: MbRecordingRelease): boolean =>
  !!release['release-group']?.id &&
  !UNUSABLE_STATUS.has((release.status ?? '').toLowerCase());

/**
 * Rank of a release for representing a song: album, single, EP, other
 * primary types, secondary types, compilations last.
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
 * A recording as a song version, or null if unrequestable: a video, or only
 * on unofficial releases or DJ mixes.
 */
export const toVersion = (recording: MbRecording): SongVersion | null => {
  const credits = recording['artist-credit'] ?? [];
  if (recording.video || !credits.length) {
    return null;
  }
  const artist = credits[0].artist.id;
  const releases = (recording.releases ?? []).filter(usable);
  const groups = new Map<string, SongRelease>();
  for (const release of releases) {
    const group = release['release-group'];
    if (!group) {
      continue;
    }
    const date = release.date || null;
    const byArtist =
      !release['artist-credit']?.length ||
      release['artist-credit'].some((credit) => credit.artist.id === artist);
    const known = groups.get(group.id);
    if (known) {
      if (date && (!known.date || date < known.date)) {
        known.date = date;
      }
      known.byArtist ||= byArtist;
      continue;
    }
    groups.set(group.id, {
      mbId: group.id,
      title: group.title,
      primaryType: group['primary-type'] ?? null,
      secondaryTypes: group['secondary-types'] ?? [],
      date,
      byArtist,
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
    artistMbid: artist,
    artistName: credits
      .map((credit) => `${credit.name}${credit.joinphrase ?? ''}`)
      .join('')
      .trim(),
    from: releaseGroups[0],
    releaseGroups,
    releaseCount: releases.length,
  };
};

/** Rank of a single or EP for fetching one song; lower is better. */
const asSingle = (group: SongRelease): number =>
  (group.secondaryTypes.length ? 2 : 0) + (group.primaryType === 'EP' ? 1 : 0);

/**
 * The artist's single or EP with this recording, for Lidarr to fetch:
 * plain singles before EPs and remix singles, earliest first. Null when
 * only on albums.
 */
export const singleFor = (
  version: Pick<SongVersion, 'releaseGroups'>
): SongRelease | null =>
  version.releaseGroups
    .filter(
      (group) =>
        group.byArtist &&
        (group.primaryType === 'Single' || group.primaryType === 'EP') &&
        // Live singles are allowed: a live take may only be on one.
        !group.secondaryTypes.some((type) =>
          ['Compilation', 'DJ-mix'].includes(type)
        )
    )
    .sort(
      (a, b) =>
        asSingle(a) - asSingle(b) ||
        (a.date || '9999').localeCompare(b.date || '9999')
    )[0] ?? null;

/** Rank of an album for taking one song from; lower is better. */
const asAlbum = (group: SongRelease): number =>
  group.secondaryTypes.some((type) => ['Compilation', 'Live'].includes(type))
    ? 2
    : group.secondaryTypes.length
      ? 1
      : 0;

/**
 * The artist's albums a version can be taken from (Lidarr adds albums by
 * artist), best first: studio, then other secondary types, then
 * compilation or live; earliest first. Never DJ mixes.
 */
export const albumsFor = (
  version: Pick<SongVersion, 'releaseGroups'>
): SongRelease[] =>
  version.releaseGroups
    .filter(
      (group) =>
        group.byArtist &&
        group.primaryType === 'Album' &&
        !group.secondaryTypes.includes(MIX_ONLY)
    )
    .sort(
      (a, b) =>
        asAlbum(a) - asAlbum(b) ||
        (a.date || '9999').localeCompare(b.date || '9999')
    );

/** Best album to take a version from. */
export const albumFor = (
  version: Pick<SongVersion, 'releaseGroups'>
): SongRelease | null => albumsFor(version)[0] ?? null;

/**
 * Groups search recordings into songs (one artist's versions of a title),
 * only for the given artists (a mash-up credits others first). Exact title
 * matches first ("Song" before "Song Medley"), then artist order, then
 * popularity.
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
      // Title and credit come from the best-known version.
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
