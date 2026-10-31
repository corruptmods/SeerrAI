/*
 * Quality profiles Seerr AI sets up in Radarr and Sonarr (Settings →
 * Quality): what is saved, per server, and the words both the server and
 * the page use for them. Nothing here talks to a server.
 */

export type ArrKind = 'radarr' | 'sonarr';

/** The presets, one per resolution, and Anime. */
export const PRESET_KEYS = [
  'sd',
  '720p',
  '1080p',
  '1080p-remux',
  '2160p',
  '2160p-remux',
  'anime',
] as const;
export type PresetKey = (typeof PRESET_KEYS)[number];

/** Where a preset comes from on one server. */
export type PresetSource = 'seerr' | 'trash' | 'off';

/** How strongly usenet is preferred over torrents. */
export type PreferUsenet = 'equal' | 'always' | 'none';

export type FileSize = 'small' | 'balanced' | 'best';

/** The audio a release must have. */
export type Languages = 'english-or-original' | 'original' | 'any';

/** A single format moved between bands, or never taken. */
export type Nudge = 'up' | 'down' | 'never';

export const BAND_STEPS = [50, 100, 250, 500] as const;
export type BandStep = (typeof BAND_STEPS)[number];

export interface QualityAdjustments {
  preferUsenet: PreferUsenet;
  /** With `always`: how long torrents wait so usenet gets the first chance. */
  torrentWaitHours: number;
  fileSize: FileSize;
  languages: Languages;
  /** HDR and Dolby Vision preferred, on the 2160p presets. */
  hdr: boolean;
  /** x265 allowed at 1080p and below; never taken when off. */
  x265At1080p: boolean;
  /** Anime: the English dub with the original audio comes first. */
  dualAudioAnime: boolean;
  /** Sonarr: files with more than one episode only as a last resort. */
  singleEpisodes: boolean;
  /** Burned-in subtitles taken only when nothing else is out. */
  burnedInLastResort: boolean;
  /**
   * AV1 taken only when nothing else is out, since many TVs and boxes
   * can't play it; taken like any other when off.
   */
  av1LastResort: boolean;
}

/** One Radarr or Sonarr server's choices. */
export interface QualityServerSettings {
  kind: ArrKind;
  /** The server's id in settings.radarr or settings.sonarr. */
  serverId: number;
  /**
   * Off for every server until an admin chooses to manage it: nothing is
   * sent to a server that isn't managed.
   */
  managed: boolean;
  presets: Partial<Record<PresetKey, PresetSource>>;
  adjustments: QualityAdjustments;
  /** By format key (see lib/quality/build). */
  nudges: Record<string, Nudge>;
  bandStep: BandStep;
  /** The TRaSH Guides copy (its commit) last applied to this server. */
  trashCommit?: string;
  /**
   * TRaSH Guides' own score, when last applied, of each TRaSH format an
   * admin moved: a later update that changes one is pointed out once.
   */
  trashRaw?: Record<string, number>;
  /**
   * The choices last applied (see lib/quality/engine), so a TRaSH Guides
   * update can be told from choices nobody has applied yet. Cleared by Undo.
   */
  appliedChoices?: string;
  /**
   * Which preset's profile new requests to this server go to (its quality
   * profile in Settings → Services), set on Apply: a preset, or 'keep' to
   * leave it as it is. Unset: the usual one (requestPresetsOf).
   */
  requestPreset?: PresetKey | 'keep';
  /** The same for anime requests: the Anime preset, or 'keep'. */
  animeRequestPreset?: 'anime' | 'keep';
}

/** The presets new requests use first, on a 4K server and on others. */
const REQUEST_ORDER: Record<'4k' | 'hd', PresetKey[]> = {
  '4k': ['2160p', '2160p-remux', '1080p-remux', '1080p', '720p', 'sd'],
  hd: ['1080p', '1080p-remux', '720p', '2160p', '2160p-remux', 'sd'],
};

/**
 * Which presets' profiles a server's new requests go to, as its choices
 * say: undefined where they are left as they are.
 */
export const requestPresetsOf = (
  config: QualityServerSettings,
  is4k: boolean
): { main?: PresetKey; anime?: PresetKey } => {
  const on = (preset: PresetKey) => (config.presets[preset] ?? 'off') !== 'off';
  const chosen = config.requestPreset;
  const main =
    chosen === 'keep'
      ? undefined
      : chosen && chosen !== 'anime' && on(chosen)
        ? chosen
        : REQUEST_ORDER[is4k ? '4k' : 'hd'].find(on);
  const anime =
    config.animeRequestPreset !== 'keep' && on('anime') ? 'anime' : undefined;
  return { main, anime };
};

export interface QualitySettings {
  trash: {
    /** TRaSH Guides updates applied without a preview. Off by default. */
    autoApply: boolean;
    /** Seerr AI builds what TRaSH Guides lacks. On by default. */
    fillGaps: boolean;
  };
  servers: QualityServerSettings[];
}

export const ADJUSTMENT_DEFAULTS: QualityAdjustments = {
  preferUsenet: 'equal',
  torrentWaitHours: 2,
  fileSize: 'balanced',
  languages: 'english-or-original',
  hdr: true,
  x265At1080p: false,
  dualAudioAnime: true,
  singleEpisodes: true,
  burnedInLastResort: true,
  av1LastResort: true,
};

export const QUALITY_DEFAULTS: QualitySettings = {
  trash: { autoApply: false, fillGaps: true },
  servers: [],
};

/** A server's choices before an admin has made any. */
export const serverDefaults = (
  kind: ArrKind,
  serverId: number,
  is4k: boolean
): QualityServerSettings => ({
  kind,
  serverId,
  managed: false,
  presets: is4k ? { '2160p': 'seerr' } : { '1080p': 'seerr', anime: 'seerr' },
  adjustments: { ...ADJUSTMENT_DEFAULTS },
  nudges: {},
  bandStep: 100,
});
