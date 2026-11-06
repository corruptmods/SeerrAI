import type { MediaServerKind } from '@server/constants/server';
import { MEDIA_ID, MEDIA_SERVER_KINDS } from '@server/constants/server';

/*
 * Which qualities a title is here in: resolutions and HDR formats, as the
 * media servers (and Radarr, for movies) reported them at the last scan.
 * Stored per source on the media row, so title pages need no server calls.
 */

/** Highest first, the order badges show in. */
export const RESOLUTIONS = ['4K', '1440p', '1080p', '720p', 'SD'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

/** Most specific first, the order badges show in. */
export const DYNAMIC_RANGES = ['DV', 'HDR10+', 'HDR10', 'HLG', 'HDR'] as const;
export type DynamicRange = (typeof DYNAMIC_RANGES)[number];

/** What one source saw of one version, or of several together. */
export interface SeenQuality {
  resolutions: Resolution[];
  /** HDR formats; empty when known to be SDR, absent when it can't tell. */
  ranges?: DynamicRange[];
}

/** The standard and 4K sides of a title, as Seerr keeps them apart. */
export type QualitySlot = 'standard' | '4k';

export type QualitySource = MediaServerKind | 'radarr';

/** The media row's stored column: each source's latest scan. */
export type StoredQuality = Partial<
  Record<QualitySource, Partial<Record<QualitySlot, SeenQuality>>>
>;

/** What a title page shows for one side. */
export interface AvailableQuality {
  resolutions: Resolution[];
  ranges: DynamicRange[];
}

const ordered = <T extends string>(
  order: readonly T[],
  values: Iterable<T>
) => {
  const set = new Set(values);
  return order.filter((value) => set.has(value));
};

/** A video's resolution class from its frame size; scope crops count by width. */
export const resolutionOf = (
  width?: number | null,
  height?: number | null
): Resolution | undefined => {
  const w = width ?? 0;
  const h = height ?? 0;
  if (w <= 0 && h <= 0) {
    return undefined;
  }
  if (w >= 3200 || h >= 1800) return '4K';
  if (w >= 2200 || h >= 1300) return '1440p';
  if (w >= 1600 || h >= 900) return '1080p';
  if (w >= 1100 || h >= 650) return '720p';
  return 'SD';
};

/** Plex's videoResolution ('4k', '1080', '720', '480', 'sd', ...). */
export const resolutionFromPlex = (
  value?: string | null
): Resolution | undefined => {
  const label = (value ?? '').toLowerCase();
  if (label === '4k') return '4K';
  if (label === '2k' || label === '1440') return '1440p';
  if (label === '1080') return '1080p';
  if (label === '720') return '720p';
  if (label === 'sd' || label === '480' || label === '576') return 'SD';
  return undefined;
};

/**
 * HDR formats from the labels servers give a video (Jellyfin's VideoRangeType
 * such as 'DOVIWithHDR10', Emby's ExtendedVideoType such as 'DolbyVision',
 * Radarr's 'DV HDR10'). [] when they say SDR; undefined when they say nothing.
 */
export const rangesFrom = (
  ...labels: (string | null | undefined)[]
): DynamicRange[] | undefined => {
  const text = labels
    .filter((label): label is string => !!label)
    .join(' ')
    .toLowerCase()
    .replace(/doviinvalid/g, '')
    .replace(/[^a-z0-9+]/g, '');
  if (!text) {
    return undefined;
  }
  const found = new Set<DynamicRange>();
  if (/dovi|dolbyvision|dv/.test(text)) found.add('DV');
  if (/hdr10(plus|\+)/.test(text)) found.add('HDR10+');
  else if (/hdr10/.test(text)) found.add('HDR10');
  if (/hlg|hyperloggamma/.test(text)) found.add('HLG');
  if (!found.size && /hdr/.test(text)) found.add('HDR');
  if (found.size) {
    return ordered(DYNAMIC_RANGES, found);
  }
  return /sdr|none/.test(text) ? [] : undefined;
};

/** Several versions or episodes as one; undefined when none has a resolution. */
export const combineQuality = (
  seen: (SeenQuality | undefined)[]
): SeenQuality | undefined => {
  const known = seen.filter((quality): quality is SeenQuality => !!quality);
  const resolutions = ordered(
    RESOLUTIONS,
    known.flatMap((quality) => quality.resolutions)
  );
  if (!resolutions.length) {
    return undefined;
  }
  const withRanges = known.filter((quality) => quality.ranges);
  return withRanges.length
    ? {
        resolutions,
        ranges: ordered(
          DYNAMIC_RANGES,
          withRanges.flatMap((quality) => quality.ranges ?? [])
        ),
      }
    : { resolutions };
};

/**
 * The stored column with one source's side replaced: null clears it,
 * undefined leaves it. Returns the same object when nothing changed.
 */
export const recordQuality = (
  stored: StoredQuality | null | undefined,
  source: QualitySource,
  slot: QualitySlot,
  seen: SeenQuality | null | undefined
): StoredQuality | null | undefined => {
  if (seen === undefined) {
    return stored;
  }
  const current = stored?.[source]?.[slot];
  if (JSON.stringify(current ?? null) === JSON.stringify(seen)) {
    return stored;
  }
  const sides = { ...stored?.[source] };
  if (seen) {
    sides[slot] = seen;
  } else {
    delete sides[slot];
  }
  const next: StoredQuality = { ...stored };
  if (Object.keys(sides).length) {
    next[source] = sides;
  } else {
    delete next[source];
  }
  return Object.keys(next).length ? next : null;
};

/** The fields of a media row this needs. */
type QualityRow = {
  quality?: StoredQuality | null;
  externalServiceId?: number | null;
  externalServiceId4k?: number | null;
} & Partial<Record<(typeof MEDIA_ID)[MediaServerKind][number], unknown>>;

/**
 * What a title page shows for one side: what the media servers still holding
 * it saw, else what Radarr has. Radarr's HDR formats are added when its file
 * matches what the servers saw, since Plex can't tell HDR from a listing.
 */
export const availableQuality = (
  media: QualityRow,
  slot: QualitySlot
): AvailableQuality | undefined => {
  const side = slot === '4k' ? 1 : 0;
  const servers = MEDIA_SERVER_KINDS.filter(
    (kind) => !!media[MEDIA_ID[kind][side]] && media.quality?.[kind]?.[slot]
  ).map((kind) => media.quality?.[kind]?.[slot]);
  const radarr =
    media[slot === '4k' ? 'externalServiceId4k' : 'externalServiceId'] != null
      ? media.quality?.radarr?.[slot]
      : undefined;

  const fromServers = combineQuality(servers);
  if (fromServers) {
    const sameFile =
      !!radarr &&
      radarr.resolutions.every((resolution) =>
        fromServers.resolutions.includes(resolution)
      );
    return {
      resolutions: fromServers.resolutions,
      ranges: ordered(DYNAMIC_RANGES, [
        ...(fromServers.ranges ?? []),
        ...(sameFile ? (radarr?.ranges ?? []) : []),
      ]),
    };
  }
  return radarr?.resolutions.length
    ? { resolutions: radarr.resolutions, ranges: radarr.ranges ?? [] }
    : undefined;
};

/** A Plex stream's HDR markers, present once Plex has analysed the file. */
interface PlexStreamInfo {
  streamType?: number;
  DOVIPresent?: boolean;
  colorTrc?: string;
}

/**
 * One Plex version (a Media entry). Library listings carry no streams, so
 * HDR is known only where Plex sent them.
 */
export const plexVersionQuality = (version: {
  width?: number;
  height?: number;
  videoResolution?: string;
  Part?: { Stream?: PlexStreamInfo[] }[];
}): SeenQuality | undefined => {
  const resolution =
    resolutionOf(version.width, version.height) ??
    resolutionFromPlex(version.videoResolution);
  if (!resolution) {
    return undefined;
  }
  const video = (version.Part ?? [])
    .flatMap((part) => part.Stream ?? [])
    .find((stream) => stream.streamType === 1);
  const ranges = video
    ? (rangesFrom(
        video.DOVIPresent ? 'dovi' : undefined,
        video.colorTrc === 'smpte2084' ? 'hdr10' : undefined,
        video.colorTrc === 'arib-std-b67' ? 'hlg' : undefined
      ) ?? [])
    : undefined;
  return ranges
    ? { resolutions: [resolution], ranges }
    : { resolutions: [resolution] };
};

/** A Jellyfin or Emby video stream's fields this reads. */
export interface JellyfinVideoInfo {
  Type?: string;
  Width?: number;
  Height?: number;
  /** Jellyfin: 'SDR' or 'HDR'. */
  VideoRange?: string;
  /** Jellyfin: 'SDR', 'HDR10', 'HDR10Plus', 'HLG', 'DOVI', 'DOVIWithHDR10'... */
  VideoRangeType?: string;
  /** Emby: 'None', 'Hdr10', 'Hdr10Plus', 'HyperLogGamma', 'DolbyVision'. */
  ExtendedVideoType?: string;
  /** Emby: the Dolby Vision profile or HDR kind, such as 'DoviProfile81'. */
  ExtendedVideoSubType?: string;
}

/** One Jellyfin or Emby media source (a version), by its video stream. */
export const jellyfinSourceQuality = (source: {
  MediaStreams?: JellyfinVideoInfo[];
}): SeenQuality | undefined => {
  const video = source.MediaStreams?.find((stream) => stream.Type === 'Video');
  const resolution = resolutionOf(video?.Width, video?.Height);
  if (!video || !resolution) {
    return undefined;
  }
  const ranges = rangesFrom(
    video.VideoRangeType,
    video.VideoRange,
    video.ExtendedVideoType,
    video.ExtendedVideoSubType
  );
  return ranges
    ? { resolutions: [resolution], ranges }
    : { resolutions: [resolution] };
};

/** A Radarr movie file: Radarr reads every file's media info on import. */
export const radarrFileQuality = (file?: {
  mediaInfo?: {
    resolution?: string;
    videoDynamicRange?: string;
    videoDynamicRangeType?: string;
  };
  quality?: { quality?: { resolution?: number } };
}): SeenQuality | undefined => {
  const [width, height] = (file?.mediaInfo?.resolution ?? '')
    .split('x')
    .map(Number);
  const resolution =
    resolutionOf(
      Number.isFinite(width) ? width : undefined,
      Number.isFinite(height) ? height : undefined
    ) ?? resolutionOf(undefined, file?.quality?.quality?.resolution);
  if (!resolution) {
    return undefined;
  }
  if (!file?.mediaInfo) {
    return { resolutions: [resolution] };
  }
  return {
    resolutions: [resolution],
    ranges:
      rangesFrom(
        file.mediaInfo.videoDynamicRangeType,
        file.mediaInfo.videoDynamicRange
      ) ?? [],
  };
};
