import type { ArrCustomFormat } from '@server/lib/autofix/arr';
import type {
  ArrKind,
  FileSize,
  Languages,
  PresetKey,
} from '@server/lib/quality/types';

/*
 * Seerr AI's own presets: the qualities each takes, best first, and the
 * custom formats it adds, with the score each gets. These are also the
 * gaps it fills beside TRaSH Guides (SD, 720p, and the rules TRaSH Guides
 * has no format for).
 */

/** What everything Seerr AI creates in Radarr and Sonarr is named with. */
export const NAME_PREFIX = 'Seerr AI · ';

/** Never taken: low enough that no score makes up for it. */
export const NEVER = -1_000_000;
/** Taken only when nothing else is out. */
export const LAST_RESORT = -10_000;
/**
 * The lowest score a release may have: two last-resort formats together
 * still pass, a never format does not.
 */
export const LOWEST_TAKEN = 2 * LAST_RESORT;

export const PRESET_LABELS: Record<PresetKey, string> = {
  sd: 'SD',
  '720p': '720p',
  '1080p': '1080p',
  '1080p-remux': '1080p Remux',
  '2160p': '2160p',
  '2160p-remux': '2160p Remux',
  anime: 'Anime',
};

export const profileName = (preset: PresetKey) =>
  `${NAME_PREFIX}${PRESET_LABELS[preset]}`;

/** A rung of a profile's ladder: one quality, or several as one. */
export interface LadderEntry {
  name: string;
  allowed: boolean;
  /** The qualities of a group; absent for a single quality. */
  items?: string[];
}

export interface Ladder {
  /** Best first. */
  entries: LadderEntry[];
  /** The entry upgrades stop at. */
  cutoff: string;
}

const web = (resolution: string): LadderEntry => ({
  name: `WEB ${resolution}`,
  allowed: true,
  items: [`WEBDL-${resolution}`, `WEBRip-${resolution}`],
});
const one = (name: string): LadderEntry => ({ name, allowed: true });

const remux = (kind: ArrKind, resolution: '1080p' | '2160p') =>
  kind === 'radarr' ? `Remux-${resolution}` : `Bluray-${resolution} Remux`;

/** Seerr AI's ladder for a preset, in this app's names. */
export const seerrLadder = (preset: PresetKey, kind: ArrKind): Ladder => {
  const movies = kind === 'radarr';
  switch (preset) {
    case 'sd':
      return {
        entries: [
          one('Bluray-576p'),
          one('Bluray-480p'),
          web('480p'),
          one('DVD'),
          one('SDTV'),
        ],
        cutoff: 'Bluray-576p',
      };
    case '720p':
      return {
        entries: [one('Bluray-720p'), web('720p'), one('HDTV-720p')],
        cutoff: movies ? 'Bluray-720p' : 'WEB 720p',
      };
    case '1080p':
      return {
        entries: [one('Bluray-1080p'), web('1080p'), one('HDTV-1080p')],
        cutoff: movies ? 'Bluray-1080p' : 'WEB 1080p',
      };
    case '1080p-remux':
      return {
        entries: [one(remux(kind, '1080p')), one('Bluray-1080p'), web('1080p')],
        cutoff: remux(kind, '1080p'),
      };
    case '2160p':
      return {
        entries: [one('Bluray-2160p'), web('2160p')],
        cutoff: movies ? 'Bluray-2160p' : 'WEB 2160p',
      };
    case '2160p-remux':
      return {
        entries: [one(remux(kind, '2160p')), one('Bluray-2160p'), web('2160p')],
        cutoff: remux(kind, '2160p'),
      };
    case 'anime':
      return {
        entries: [
          one('Bluray-1080p'),
          web('1080p'),
          one('HDTV-1080p'),
          one('Bluray-720p'),
          web('720p'),
          one('HDTV-720p'),
        ],
        cutoff: 'Bluray-1080p',
      };
  }
};

/** The looser preset a title steps down to, when nothing is found. */
export const LOOSER: Partial<Record<PresetKey, PresetKey>> = {
  '2160p-remux': '2160p',
  '2160p': '1080p',
  '1080p-remux': '1080p',
  '1080p': '720p',
  '720p': 'sd',
};

/** A Seerr AI format, before Radarr or Sonarr gives it an id. */
export interface SeerrFormat {
  key: string;
  format: ArrCustomFormat;
}

const title = (name: string, value: string, required = false) => ({
  name,
  implementation: 'ReleaseTitleSpecification',
  negate: false,
  required,
  fields: [{ name: 'value', value }],
});

const language = (name: string, value: number) => ({
  name,
  implementation: 'LanguageSpecification',
  negate: true,
  required: true,
  fields: [
    { name: 'value', value },
    { name: 'exceptLanguage', value: false },
  ],
});

const named = (
  key: string,
  label: string,
  specifications: ArrCustomFormat['specifications']
): SeerrFormat => ({
  key: `seerr:${key}`,
  format: {
    name: `${NAME_PREFIX}${label}`,
    includeCustomFormatWhenRenaming: false,
    specifications,
  },
});

export const REPACK = named('repack', 'Repack or proper', [
  title('Repack or proper', '\\b(repack\\d?|proper\\d?|rerip\\d?)\\b'),
]);

export const HDR = named('hdr', 'HDR or Dolby Vision', [
  title(
    'HDR or Dolby Vision',
    '\\b(HDR(10)?(\\+|Plus)?|DV|DoVi|Dolby[ ._-]?Vision)\\b'
  ),
]);

export const X265_HD = named('x265-hd', 'x265 at 1080p or below', [
  title('x265', '(((x|h)\\.?265)|(HEVC))', true),
  {
    name: 'Not 2160p',
    implementation: 'ResolutionSpecification',
    negate: true,
    required: true,
    fields: [{ name: 'value', value: 2160 }],
  },
]);

export const UPSCALED = named('upscaled', 'Upscaled', [
  title('Upscaled', '\\b(upscal(e|ed|ing)|ai[ ._-]?upscaled?|regraded?)\\b'),
]);

/** Releases in a language they shouldn't be, read from the name. */
export const languageFormat = (choice: Languages): SeerrFormat | undefined =>
  choice === 'any'
    ? undefined
    : named('language', 'Wrong language', [
        ...(choice === 'english-or-original'
          ? [language('Not English', 1)]
          : []),
        language('Not the original language', -2),
        // A name that says nothing of its language is not wrong.
        language('Language known', 0),
      ]);

/** AV1 video, which many TVs and streaming boxes can't play. */
export const AV1 = named('av1', 'AV1', [title('AV1', '\\bAV1\\b', true)]);

export const BURNED_IN = named('burned-in', 'Burned-in subtitles', [
  title(
    'Burned-in subtitles',
    '\\b(HC|hardsub(bed|s)?|hardcoded([ ._-]subs?)?|KORSUB)\\b'
  ),
]);

export const DUAL_AUDIO = named('dual-audio', 'Dual audio', [
  title(
    'Dual audio',
    '\\b(dual[ ._-]?audio|multi[ ._-]?audio|eng(lish)?[ ._-]?(\\+|&|and)[ ._-]?(jap|jpn|japanese))\\b'
  ),
]);

/** Sonarr only: one file holding several episodes. */
export const MULTI_EPISODE = named('multi-episode', 'More than one episode', [
  {
    name: 'Multi-episode',
    implementation: 'ReleaseTypeSpecification',
    negate: false,
    required: false,
    fields: [{ name: 'value', value: 2 }],
  },
]);

/** Radarr: a film bigger than this is a last resort. */
export const sizeFormat = (gb: number): SeerrFormat =>
  named(`size-${gb}`, `Over ${gb} GB`, [
    {
      name: `Over ${gb} GB`,
      implementation: 'SizeSpecification',
      negate: false,
      required: false,
      fields: [
        { name: 'min', value: gb },
        { name: 'max', value: 10_000 },
      ],
    },
  ]);

/** Radarr: the largest film (about two hours) each preset takes first. */
export const FILM_CAPS_GB: Record<
  Exclude<FileSize, 'best'>,
  Record<PresetKey, number>
> = {
  small: {
    sd: 2,
    '720p': 4,
    '1080p': 8,
    '1080p-remux': 30,
    '2160p': 20,
    '2160p-remux': 60,
    anime: 6,
  },
  balanced: {
    sd: 4,
    '720p': 8,
    '1080p': 15,
    '1080p-remux': 45,
    '2160p': 40,
    '2160p-remux': 90,
    anime: 12,
  },
};

/** Sonarr v5: the most each preset takes, in MB a minute. */
export const EPISODE_CAPS_MB_MIN: Record<
  Exclude<FileSize, 'best'>,
  Record<PresetKey, number>
> = {
  small: {
    sd: 10,
    '720p': 15,
    '1080p': 25,
    '1080p-remux': 80,
    '2160p': 60,
    '2160p-remux': 200,
    anime: 20,
  },
  balanced: {
    sd: 15,
    '720p': 30,
    '1080p': 45,
    '1080p-remux': 150,
    '2160p': 120,
    '2160p-remux': 400,
    anime: 40,
  },
};

/** The raw scores of Seerr AI's own formats in its presets. */
export const SEERR_SCORES = {
  repack: 5,
  hdr: 500,
  dualAudio: 1000,
};

export const is2160 = (preset: PresetKey) =>
  preset === '2160p' || preset === '2160p-remux';

/**
 * The TRaSH Guides formats each of Seerr AI's own does the work of, by
 * name. The pre-build review (bin/quality-review.mjs) says when one of
 * these changes in TRaSH Guides, so ours can follow.
 */
export const TRASH_EQUIVALENTS: Record<ArrKind, Record<string, string[]>> = {
  radarr: {
    [REPACK.key]: ['Repack/Proper'],
    [HDR.key]: ['HDR'],
    [X265_HD.key]: ['x265 (HD)'],
    [UPSCALED.key]: ['Upscaled'],
    [AV1.key]: ['AV1'],
    'seerr:language': ['Language: Not English', 'Language: Not Original'],
    [DUAL_AUDIO.key]: ['Anime Dual Audio'],
  },
  sonarr: {
    [REPACK.key]: ['Repack/Proper'],
    [HDR.key]: ['HDR'],
    [X265_HD.key]: ['x265 (HD)'],
    [UPSCALED.key]: ['Upscaled'],
    [AV1.key]: ['AV1'],
    'seerr:language': ['Language: Not English', 'Language: Not Original'],
    [DUAL_AUDIO.key]: ['Anime Dual Audio'],
    [MULTI_EPISODE.key]: ['Multi-Episode'],
  },
};
