/*
 * What Download Check looks for, as plain functions: a grab's files, its
 * timing against the episode's air date, whether it can be an upgrade on
 * the file there is, and what a blocked import's messages mean. Nothing
 * here asks a server anything.
 */

/** File types Sonarr and Radarr import as video. */
export const VIDEO_EXTENSIONS = new Set([
  'mkv',
  'mp4',
  'm4v',
  'avi',
  'mov',
  'wmv',
  'mpg',
  'mpeg',
  'm2ts',
  'ts',
  'webm',
  'flv',
  'ogm',
  'ogv',
  'vob',
  'divx',
  'xvid',
  'mk3d',
  'rmvb',
  'iso',
  'img',
  'wtv',
]);

/** Programs: never part of a film or an episode. */
export const PROGRAM_EXTENSIONS = new Set([
  'exe',
  'scr',
  'lnk',
  'bat',
  'cmd',
  'com',
  'msi',
  'pif',
  'vbs',
  'vbe',
  'ps1',
  'hta',
  'wsf',
  'jar',
  'apk',
  'cpl',
  'reg',
]);

const ARCHIVE = /\.(rar|r\d{2,3}|zip|7z|001|tar|tgz|gz|bz2|xz)$/i;

/** A video this small is a sample or a stand-in, never a whole episode. */
export const SAMPLE_BYTES = 50 * 1024 * 1024;

/** A video at least this big is taken for the real thing at import. */
export const REAL_VIDEO_BYTES = 100 * 1024 * 1024;

const extensionOf = (name: string): string =>
  (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();

export const isVideo = (name: string): boolean =>
  VIDEO_EXTENSIONS.has(extensionOf(name));

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

export type FileProblem =
  | { code: 'program'; files: string[] }
  | { code: 'archive'; files: string[] }
  | { code: 'noVideo'; files: string[] }
  | { code: 'sample'; files: string[] };

/**
 * What a torrent's files say about it, wanted files only (a file set to
 * skip doesn't come down). Programs first: whatever else it has, a release
 * with a program in it is not what it says it is.
 */
export const checkFiles = (
  files: { name: string; size: number }[]
): FileProblem | undefined => {
  if (!files.length) return undefined;
  const programs = files
    .filter((f) => PROGRAM_EXTENSIONS.has(extensionOf(f.name)))
    .map((f) => baseName(f.name));
  if (programs.length) return { code: 'program', files: programs.slice(0, 5) };
  const videos = files.filter((f) => isVideo(f.name));
  if (!videos.length) {
    const archives = files.filter((f) => ARCHIVE.test(f.name));
    if (archives.length) {
      return {
        code: 'archive',
        files: archives.map((f) => baseName(f.name)).slice(0, 3),
      };
    }
    return {
      code: 'noVideo',
      files: files.map((f) => baseName(f.name)).slice(0, 3),
    };
  }
  if (videos.every((f) => f.size < SAMPLE_BYTES)) {
    return {
      code: 'sample',
      files: videos.map((f) => baseName(f.name)).slice(0, 3),
    };
  }
  return undefined;
};

/** A grab this far ahead of its episode's air time is a fake. */
export const PRE_AIR_MS = 24 * 3600_000;

/**
 * Hours a grab came before its episodes aired, when every one of them airs
 * more than a day after it; undefined otherwise, or when an air date is
 * unknown. A real episode can turn up hours early; days early, it's a fake
 * named after it.
 */
export const hoursBeforeAir = (
  grabbedAt: number,
  airDates: (string | undefined)[]
): number | undefined => {
  if (!airDates.length || !Number.isFinite(grabbedAt)) return undefined;
  const times = airDates.map((d) => (d ? new Date(d).getTime() : NaN));
  if (times.some((t) => !Number.isFinite(t))) return undefined;
  const first = Math.min(...times);
  return first - grabbedAt > PRE_AIR_MS
    ? Math.round((first - grabbedAt) / 3600_000)
    : undefined;
};

export interface Quality {
  quality: { id: number; name: string };
  revision?: { version: number; real: number };
}

/** A quality profile's ranking: what Sonarr and Radarr compare with. */
export interface ProfileRanks {
  /** Quality id to its place in the profile, higher better. */
  rank: Map<number, number>;
}

interface ProfileItem {
  quality?: { id: number };
  items?: ProfileItem[];
}

/**
 * A profile's items run from worst to best; the qualities in one group
 * rank alike.
 */
export const ranksOf = (profile: { items: ProfileItem[] }): ProfileRanks => {
  const rank = new Map<number, number>();
  profile.items.forEach((item, i) => {
    if (item.quality) rank.set(item.quality.id, i);
    for (const inner of item.items ?? []) {
      if (inner.quality) rank.set(inner.quality.id, i);
    }
  });
  return { rank };
};

export interface Held {
  quality: Quality;
  customFormatScore?: number;
}

export type UpgradeVerdict =
  | { upgrade: true }
  | {
      upgrade: false;
      why: 'quality' | 'revision' | 'score';
      have: string;
      offered: string;
    };

const label = (held: Held, why: 'quality' | 'revision' | 'score') =>
  why === 'score'
    ? `${held.quality.quality.name} (${held.customFormatScore ?? 0})`
    : why === 'revision'
      ? `${held.quality.quality.name} v${held.quality.revision?.version ?? 1}`
      : held.quality.quality.name;

/**
 * Whether Sonarr or Radarr will take `offered` over the file it has, the
 * way their import does: a lower quality is refused, the same quality in an
 * older revision is refused, and the same quality scoring lower on custom
 * formats is refused. A quality the profile doesn't rank is let through:
 * the import decides those.
 */
export const isUpgrade = (
  ranks: ProfileRanks,
  have: Held,
  offered: Held
): UpgradeVerdict => {
  const a = ranks.rank.get(have.quality.quality.id);
  const b = ranks.rank.get(offered.quality.quality.id);
  if (a === undefined || b === undefined) return { upgrade: true };
  const no = (why: 'quality' | 'revision' | 'score'): UpgradeVerdict => ({
    upgrade: false,
    why,
    have: label(have, why),
    offered: label(offered, why),
  });
  if (b < a) return no('quality');
  if (b > a) return { upgrade: true };
  const ra = have.quality.revision;
  const rb = offered.quality.revision;
  if (ra && rb) {
    if (rb.version < ra.version) return no('revision');
    if (rb.version === ra.version && rb.real < ra.real) return no('revision');
  }
  if (
    have.customFormatScore !== undefined &&
    offered.customFormatScore !== undefined &&
    offered.customFormatScore < have.customFormatScore
  ) {
    return no('score');
  }
  return { upgrade: true };
};

/** How one grab ranks against another for the same episodes or movie. */
export const compareGrabs = (ranks: ProfileRanks, a: Held, b: Held): number => {
  const ra = ranks.rank.get(a.quality.quality.id) ?? -1;
  const rb = ranks.rank.get(b.quality.quality.id) ?? -1;
  if (ra !== rb) return ra - rb;
  const va = a.quality.revision?.version ?? 1;
  const vb = b.quality.revision?.version ?? 1;
  if (va !== vb) return va - vb;
  return (a.customFormatScore ?? 0) - (b.customFormatScore ?? 0);
};

/**
 * What a blocked import's message means. Sonarr and Radarr word them the
 * same way in every version since v3; anything else is left for an admin.
 */
export type ImportProblem =
  /** Grabbed on the indexer's id; the name doesn't say this title. */
  | 'byId'
  /** TheXEM hasn't confirmed the episode's numbering yet. */
  | 'xem'
  /** Not better than the file there. */
  | 'notUpgrade'
  /** The file there holds more episodes than this one. */
  | 'moreEpisodes'
  | 'alreadyImported'
  /** Some of a pack came in; the rest wasn't there. */
  | 'partial'
  /** The runtime isn't known, so a sample can't be ruled out. */
  | 'sampleUnsure'
  /** The file's name says nothing Sonarr can read. */
  | 'unparsed'
  /** Wrong, broken or packed files: nothing in it to import. */
  | 'badFiles'
  | 'unknown';

const PROBLEMS: [RegExp, ImportProblem][] = [
  [/matched to (series|movie) by ID/i, 'byId'],
  [/TheXEM/i, 'xem'],
  [/contains more episodes than this file/i, 'moreEpisodes'],
  [
    /Not an upgrade|Not a Custom Format upgrade|not a revision upgrade/i,
    'notUpgrade',
  ],
  [/already imported/i, 'alreadyImported'],
  [
    /One or more (episodes|movies) expected in this release were not imported or missing/i,
    'partial',
  ],
  [/Unable to determine if file is a sample/i, 'sampleUnsure'],
  [/Unable to parse file/i, 'unparsed'],
  [
    /^Sample$|No files found are eligible for import|Found archive file|Invalid season or episode|was not found in the grabbed release|was unexpected considering|Single episode file contains all episodes|No audio tracks|Unknown (Series|Movie)|Unable to identify correct|Couldn't find similar|Invalid video file|Not a video file|unsupported extension|is a sample/i,
    'badFiles',
  ],
];

export const importProblemOf = (message: string): ImportProblem =>
  PROBLEMS.find(([re]) => re.test(message))?.[1] ?? 'unknown';

/** Problems that leave the download worth importing, once confirmed. */
const IMPORTABLE: ImportProblem[] = ['xem', 'sampleUnsure', 'unparsed'];

export type ImportPlan =
  /** Import it, telling the server which episodes or movie it is. */
  | 'import'
  /** Throw it away: blocklisted, searched again where still missing. */
  | 'reject'
  /** Done with: out of the queue, left in the client, the rest searched. */
  | 'clear'
  /** The name decides: same title, another or can't tell. */
  | 'byName'
  | 'review';

/**
 * What to do about an import that's blocked, from all its messages. One
 * message we can't read and it waits for an admin; one bad file and the
 * rest of a pack is still imported by `clear` once Sonarr says only part
 * of it came in.
 */
export const planImport = (problems: ImportProblem[]): ImportPlan => {
  const all = new Set(problems);
  if (!all.size || all.has('unknown')) return 'review';
  if (all.has('byId')) return 'byName';
  if (all.has('partial')) return 'clear';
  if (all.has('badFiles') || all.has('notUpgrade') || all.has('moreEpisodes')) {
    return 'reject';
  }
  if ([...all].every((p) => p === 'alreadyImported')) return 'clear';
  if (
    [...all].every((p) => IMPORTABLE.includes(p) || p === 'alreadyImported')
  ) {
    return 'import';
  }
  return 'review';
};
