/*
 * Quality profiles Seerr AI manages in Radarr and Sonarr (Settings →
 * Quality): per-server saved settings and the vocabulary shared by server
 * and page. Nothing here calls a server.
 */

export type ArrKind = 'radarr' | 'sonarr';

/** One preset per resolution, plus Anime. */
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

/** A preset's source on one server. */
export type PresetSource = 'seerr' | 'trash' | 'off';

/** How strongly usenet is preferred over torrents. */
export type PreferUsenet = 'equal' | 'always' | 'none';

export type FileSize = 'small' | 'balanced' | 'best';

/**
 * One preset's file size: one of the three above, or a custom limit in MB
 * per minute (Sonarr) or GB per movie (Radarr).
 */
export type PresetSize = FileSize | number;

/** Max custom limit: Sonarr's own max (MB per minute), or GB per movie. */
export const MAX_OWN_SIZE = 1000;

/** Required audio language. */
export type Languages = 'english-or-original' | 'original' | 'any';

/** Moves one format up or down a band, or never takes it. */
export type Nudge = 'up' | 'down' | 'never';

export const BAND_STEPS = [50, 100, 250, 500] as const;
export type BandStep = (typeof BAND_STEPS)[number];

export interface QualityAdjustments {
  preferUsenet: PreferUsenet;
  /** With `always`: torrent delay so usenet gets the first chance. */
  torrentWaitHours: number;
  fileSize: FileSize;
  languages: Languages;
  /** Prefer HDR and Dolby Vision on the 2160p presets. */
  hdr: boolean;
  /** Allow x265 at 1080p and below; never taken when off. */
  x265At1080p: boolean;
  /** Anime: prefer English dub plus original audio. */
  dualAudioAnime: boolean;
  /** Sonarr: multi-episode files only as a last resort. */
  singleEpisodes: boolean;
  /** Burned-in subtitles only when nothing else is available. */
  burnedInLastResort: boolean;
  /**
   * AV1 only when nothing else is available, since many TVs and boxes
   * can't play it. When off, AV1 is treated like any other codec.
   */
  av1LastResort: boolean;
}

/** One Radarr or Sonarr server's choices. */
export interface QualityServerSettings {
  kind: ArrKind;
  /** The server's id in settings.radarr or settings.sonarr. */
  serverId: number;
  /** Off until an admin opts in; nothing is sent to an unmanaged server. */
  managed: boolean;
  presets: Partial<Record<PresetKey, PresetSource>>;
  adjustments: QualityAdjustments;
  /** Per-preset file size; a preset without one uses adjustments.fileSize. */
  sizes?: Partial<Record<PresetKey, PresetSize>>;
  /** By format key (see lib/quality/build). */
  nudges: Record<string, Nudge>;
  bandStep: BandStep;
  /** The TRaSH Guides commit last applied to this server. */
  trashCommit?: string;
  /**
   * TRaSH Guides' score at last apply for each TRaSH format an admin moved,
   * so a later update that changes one is flagged once.
   */
  trashRaw?: Record<string, number>;
  /**
   * The choices last applied (see lib/quality/engine), to tell a TRaSH
   * Guides update apart from unapplied choices. Cleared by Undo.
   */
  appliedChoices?: string;
  /**
   * Preset whose profile new requests to this server use (its quality
   * profile in Settings → Services), set on Apply; 'keep' leaves it as is.
   * Unset uses the default (requestPresetsOf).
   */
  requestPreset?: PresetKey | 'keep';
  /** Same, for anime requests: the Anime preset, or 'keep'. */
  animeRequestPreset?: 'anime' | 'keep';
}

/** Preset preference order for new requests, on 4K and other servers. */
const REQUEST_ORDER: Record<'4k' | 'hd', PresetKey[]> = {
  '4k': ['2160p', '2160p-remux', '1080p-remux', '1080p', '720p', 'sd'],
  hd: ['1080p', '1080p-remux', '720p', '2160p', '2160p-remux', 'sd'],
};

/** Preset profiles a server's new requests use; undefined where left as is. */
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
    /** Apply TRaSH Guides updates without a preview. Off by default. */
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

/** A server's default choices. */
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
