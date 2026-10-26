import type {
  LidarrAlbum,
  LidarrArtist,
  LidarrQualityModel,
  LidarrRelease,
} from '@server/api/servarr/lidarr';
import type BackfillLidarr from '@server/lib/backfill/lidarr';
import type { AlbumTrack, AlbumTrackFile } from '@server/lib/backfill/lidarr';
import type { PackFile } from '@server/lib/backfill/matcher';
import type { PlanEntry, PlanSummary } from '@server/lib/backfill/plan';
import { decide, dedupe, summarize } from '@server/lib/backfill/plan';
import type {
  SonarrEpisode,
  SonarrEpisodeFile,
  SonarrQuality,
  SonarrQualityProfile,
} from '@server/lib/backfill/sonarr';
import {
  fileForTrack,
  isAudio,
  namesAlbum,
} from '@server/lib/music/albumRelease';
import { bestRelease } from '@server/lib/music/songRelease';

/*
 * An album's release, judged as Lidarr would import it: which of its files
 * is each track of the album, in which edition of it (Lidarr imports into
 * the tracks of one release), at what quality, and whether each fills a
 * missing track or would replace one Lidarr keeps. The plan's own rules
 * (the profile's order of qualities, then the custom format score) decide.
 */

export interface AlbumContext {
  album: LidarrAlbum;
  artist: LidarrArtist;
  /** The tracks of the release Lidarr monitors. */
  tracks: AlbumTrack[];
  /** The album's files on disk. */
  files: AlbumTrackFile[];
  profile: SonarrQualityProfile;
  /** What the album goes by in searches: "Artist Album", "Album". */
  names: string[];
  lidarr: BackfillLidarr;
  /** Another edition's tracks, asked for once each. */
  editionTracks: (releaseId: number) => Promise<AlbumTrack[]>;
}

/** Below this a file is a sample or a skit's stub, not a track. */
const MIN_TRACK_BYTES = 200 * 1024;

/** A box set's worth of files is the most read from one release. */
const MAX_PACK_FILES = 400;

/** Editions tried for a release with no files on disk yet. */
const MAX_EDITIONS = 4;

/** Lidarr's quality, in the shape the plan judges qualities in. */
export const asQuality = (model: LidarrQualityModel): SonarrQuality => ({
  quality: model.quality,
  revision: model.revision ?? { version: 1, real: 0 },
});

/** "03 - Song.flac" is 3, "1-03 Song.flac" and "103 Song.flac" are 3 too. */
const fileNumber = (path: string): number | undefined => {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? path;
  const match = name.match(/^(?:\d{1,2}[-.\s]+)?(\d{1,3})(?=[\s._-])/);
  if (!match) return undefined;
  const n = Number(match[1]);
  // "103" on a single disc is track 3 of disc 1.
  return n > 100 && n < 1000 ? n % 100 : n;
};

/** Each track's file in the release: by its title, else by its number. */
export const mapTracks = (
  audio: PackFile[],
  tracks: AlbumTrack[],
  artist: string
): Map<number, PackFile> => {
  const placed = new Map<number, PackFile>();
  const used = new Set<number>();
  for (const track of tracks) {
    const file = fileForTrack(
      audio.filter((f) => !used.has(f.index)),
      track.title,
      artist
    );
    if (file) {
      placed.set(track.id, file);
      used.add(file.index);
    }
  }
  // Untitled files ("Track 03.flac"), or titles spelt otherwise: by number,
  // when the release has one file for each track.
  if (audio.length === tracks.length) {
    for (const track of tracks) {
      if (placed.has(track.id)) continue;
      const number =
        track.absoluteTrackNumber ?? (Number(track.trackNumber) || undefined);
      const file = audio.find(
        (f) => !used.has(f.index) && number && fileNumber(f.path) === number
      );
      if (file) {
        placed.set(track.id, file);
        used.add(file.index);
      }
    }
  }
  return placed;
};

/**
 * The edition to import a release into. An album with files keeps its
 * edition: another would leave them behind. Otherwise the one whose tracks
 * the release's files are most of, the likeliest first.
 */
const chooseEdition = async (
  audio: PackFile[],
  ctx: AlbumContext
): Promise<{ releaseId: number; tracks: AlbumTrack[] } | undefined> => {
  const releases = ctx.album.releases ?? [];
  const monitored = releases.find((r) => r.monitored);
  if (ctx.files.length || !releases.length) {
    return monitored
      ? { releaseId: monitored.id, tracks: ctx.tracks }
      : undefined;
  }
  // The likeliest editions: as many tracks as the release has files, the
  // usual official ones first, Lidarr's own pick before others alike.
  const ofSize = releases.filter((r) => r.trackCount === audio.length);
  const likely: LidarrRelease[] = [];
  const pool = ofSize.length ? ofSize : releases;
  for (let i = 0; i < MAX_EDITIONS && pool.length; i++) {
    const next = bestRelease(
      pool.filter((r) => !likely.includes(r)),
      new Map([['any', new Set(pool.map((r) => r.foreignReleaseId))]])
    );
    if (!next) break;
    likely.push(next);
  }
  if (monitored && !likely.includes(monitored)) likely.push(monitored);
  let best:
    | { releaseId: number; tracks: AlbumTrack[]; placed: number }
    | undefined;
  for (const release of likely) {
    const tracks =
      release.id === monitored?.id
        ? ctx.tracks
        : await ctx.editionTracks(release.id);
    const placed = mapTracks(audio, tracks, ctx.artist.artistName).size;
    if (!best || placed > best.placed) {
      best = { releaseId: release.id, tracks, placed };
    }
    if (placed === tracks.length && placed > 0) break;
  }
  return best && { releaseId: best.releaseId, tracks: best.tracks };
};

/** A release's files, judged against the album, and what they add up to. */
export const judgeAlbumPack = async (
  files: PackFile[],
  packTitle: string,
  ctx: AlbumContext
): Promise<{ plan: PlanEntry[]; summary: PlanSummary }> => {
  const audio = files
    .filter((file) => isAudio(file.path) && file.size >= MIN_TRACK_BYTES)
    .slice(0, MAX_PACK_FILES);
  const pack = await ctx.lidarr.parse(packTitle);
  const ours =
    namesAlbum(packTitle, ctx.album.title, ctx.artist.artistName) ||
    !!pack.albums?.some((a) => a.id === ctx.album.id);
  const edition = ours ? await chooseEdition(audio, ctx) : undefined;
  const placed = edition
    ? mapTracks(audio, edition.tracks, ctx.artist.artistName)
    : new Map<number, PackFile>();
  const trackOf = new Map<number, AlbumTrack>();
  for (const track of edition?.tracks ?? []) {
    const file = placed.get(track.id);
    if (file) trackOf.set(file.index, track);
  }

  // The release's quality, from its name; a file's own, from its type,
  // when the name says nothing ("Unknown").
  const packQuality = pack.parsedAlbumInfo?.quality;
  const byType = new Map<string, LidarrQualityModel | undefined>();
  const qualityOf = async (path: string) => {
    if (packQuality && packQuality.quality.id) return packQuality;
    const type = path.split('.').pop()?.toLowerCase() ?? '';
    if (!byType.has(type)) {
      const parsed = await ctx.lidarr
        .parse(`${packTitle}.${type}`)
        .catch(() => undefined);
      byType.set(type, parsed?.parsedAlbumInfo?.quality);
    }
    return byType.get(type) ?? packQuality;
  };

  // What Lidarr has now, in the shapes the plan judges episodes in. An
  // edition other than the one on disk has nothing of its own yet.
  const sameEdition =
    edition &&
    edition.releaseId ===
      (ctx.album.releases ?? []).find((r) => r.monitored)?.id;
  const episodes = new Map<number, SonarrEpisode>(
    (edition?.tracks ?? []).map((track) => [
      track.id,
      {
        id: track.id,
        seriesId: 0,
        seasonNumber: 0,
        episodeNumber: track.absoluteTrackNumber ?? 0,
        title: track.title,
        hasFile: !!sameEdition && track.hasFile,
        monitored: true,
        episodeFileId: sameEdition ? (track.trackFileId ?? 0) : 0,
      },
    ])
  );
  const onDisk = new Map<number, SonarrEpisodeFile>(
    ctx.files.map((file) => [
      file.id,
      {
        id: file.id,
        seasonNumber: 0,
        size: file.size,
        quality: asQuality(file.quality),
      },
    ])
  );

  const plan: PlanEntry[] = [];
  for (const file of audio) {
    const track = trackOf.get(file.index);
    const base = {
      index: file.index,
      path: file.path,
      size: file.size,
      judgedAs: file.path.replace(/\\/g, '/').split('/').pop() ?? file.path,
      episodeIds: track ? [track.id] : [],
      score: pack.customFormatScore ?? 0,
    };
    if (!ours) {
      plan.push({
        ...base,
        action: 'reject',
        reason: 'Not this album',
        replaces: 0,
      });
      continue;
    }
    if (!track || !edition) {
      plan.push({
        ...base,
        action: 'reject',
        reason: 'Not a track of this album',
        replaces: 0,
      });
      continue;
    }
    const quality = await qualityOf(file.path);
    plan.push({
      ...decide(
        {
          ...base,
          episode: track.absoluteTrackNumber,
          ...(quality && { quality: asQuality(quality) }),
          releaseId: edition.releaseId,
        },
        ctx.profile,
        episodes,
        onDisk
      ),
    });
  }
  const sorted = dedupe(plan, ctx.profile).sort(
    (a, b) =>
      Number(b.episodeIds.length > 0) - Number(a.episodeIds.length > 0) ||
      (a.episode ?? 0) - (b.episode ?? 0) ||
      a.index - b.index
  );
  return { plan: sorted, summary: summarize(sorted) };
};
