import type LidarrAPI from '@server/api/servarr/lidarr';
import type {
  LidarrQualityModel,
  LidarrQueueAppend,
} from '@server/api/servarr/lidarr';
import { lidarrDuration } from '@server/api/servarr/lidarr';
import { MediaRequestStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import SongRequest from '@server/entity/SongRequest';
import { lidarrApi } from '@server/lib/music/access';
import { fileForTrack, namesAlbum } from '@server/lib/music/albumRelease';
import { trackOf } from '@server/lib/music/songFetch';
import { otherTake } from '@server/lib/music/songs';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { In } from 'typeorm';

/*
 * Lidarr blocks imports missing edition tracks (a single's download often
 * lacks the radio edit or instrumental) or whose tags don't match closely
 * ("album match is not close enough"). When such a download is named as
 * the single and has a requested song, import just that song into its
 * track. A file counts only if named as the song and, when tagged, the same
 * take and length. Unmatched downloads stay queued and show on the Health
 * page (lib/health).
 */

const LABEL = 'Music Imports';

/** Lidarr states for a finished download it hasn't imported. */
export const HELD_BACK = ['importBlocked', 'importFailed'];

/**
 * Lidarr reasons handled here: missing or unmatched tracks, or tags too far
 * from the edition. Others ("unknown artist", "not an upgrade") are left.
 */
const HANDLED =
  /missing tracks|unmatched tracks|album match is not close enough/i;

/** Max tagged-length difference between a file and its track. */
const SAME_LENGTH_MS = 8000;

/** How long before a handled download is retried. */
const TRY_AGAIN_MS = 60 * 60_000;

type QueueItem = Awaited<ReturnType<LidarrAPI['getMusicQueue']>>[number];

/** True for a finished download Lidarr hasn't imported. */
export const heldBack = (
  item: QueueItem
): item is QueueItem & Required<Pick<LidarrQueueAppend, 'outputPath'>> =>
  HELD_BACK.includes(item.trackedDownloadState) && !!item.outputPath;

/** Lidarr's reasons joined into one line. */
export const heldBackReason = (item: QueueItem): string =>
  [
    ...new Set(
      (item.statusMessages ?? []).flatMap((status) => status.messages ?? [])
    ),
  ].join(' · ');

class BlockedImports {
  /** Last attempt per download and song. */
  private tried = new Map<string, number>();
  private running = false;

  /** Imports what it can from every Lidarr's queue. */
  public async run(now = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const [key, at] of this.tried) {
        if (now - at > TRY_AGAIN_MS) this.tried.delete(key);
      }
      for (const server of getSettings().lidarr) {
        await this.server(lidarrApi(server), now).catch((e) =>
          logger.warn('Could not read a Lidarr queue for held-back imports', {
            label: LABEL,
            lidarr: server.name,
            errorMessage: e instanceof Error ? e.message : String(e),
          })
        );
      }
    } finally {
      this.running = false;
    }
  }

  private async server(api: LidarrAPI, now: number): Promise<void> {
    const held = (await api.getMusicQueue())
      .filter(heldBack)
      .filter((item) => HANDLED.test(heldBackReason(item)));
    if (!held.length) return;
    const albums = [
      ...new Set(
        held.flatMap((item) =>
          item.album?.foreignAlbumId ? [item.album.foreignAlbumId] : []
        )
      ),
    ];
    if (!albums.length) return;
    // Approved songs fetched through these singles.
    const songs = await getRepository(SongRequest).find({
      relations: { request: { media: true } },
      where: {
        singleMbid: In(albums),
        status: MediaRequestStatus.APPROVED,
      },
    });
    for (const item of held) {
      const wanted = songs.filter(
        (song) =>
          song.singleMbid === item.album?.foreignAlbumId &&
          !this.tried.has(`${item.downloadId}:${song.recordingMbid}`)
      );
      if (!wanted.length) continue;
      for (const song of wanted) {
        this.tried.set(`${item.downloadId}:${song.recordingMbid}`, now);
      }
      await this.importSongs(api, item, wanted).catch((e) =>
        logger.warn('Could not import a requested song Lidarr held back', {
          label: LABEL,
          download: item.title,
          errorMessage: e instanceof Error ? e.message : String(e),
        })
      );
    }
  }

  /** Imports each wanted song's file into its track. */
  private async importSongs(
    api: LidarrAPI,
    item: QueueItem & { outputPath: string },
    songs: SongRequest[]
  ): Promise<void> {
    const [tracks, album, found] = await Promise.all([
      api.getTracks(item.albumId),
      api.getAlbum(item.albumId),
      api.getManualImport(item.outputPath, item.artistId),
    ]);
    const release =
      album.releases?.find((r) => r.monitored) ?? album.releases?.[0];
    if (!release) return;
    const artist =
      item.artist?.artistName ?? songs[0].request?.media?.foreignTitle ?? '';
    if (!namesAlbum(item.title, album.title, artist)) {
      logger.info('A held-back download isn’t named as the single', {
        label: LABEL,
        download: item.title,
        single: album.title,
      });
      return;
    }
    const files = found.map((file, index) => ({
      index,
      path: file.path,
      // Unknown size mustn't exclude a file.
      size: file.size ?? Number.MAX_SAFE_INTEGER,
      quality: file.quality,
      title: file.audioTags?.title,
      length: lidarrDuration(file.audioTags?.duration),
    }));
    const picked: {
      path: string;
      trackId: number;
      quality?: LidarrQualityModel;
    }[] = [];
    for (const song of songs) {
      const track = trackOf(tracks, song);
      if (!track || track.hasFile) continue;
      // When tagged: same take and similar length.
      const file = fileForTrack(
        files.filter(
          (f) =>
            !picked.some((p) => p.path === f.path) &&
            !(f.title && otherTake(f.title, track.title)) &&
            !(
              f.length &&
              track.duration &&
              Math.abs(f.length - track.duration) > SAME_LENGTH_MS
            )
        ),
        track.title,
        artist
      );
      if (file) {
        picked.push({
          path: file.path,
          trackId: track.id,
          quality: file.quality,
        });
      }
    }
    if (!picked.length) {
      logger.info('A held-back download has no file that is the song', {
        label: LABEL,
        download: item.title,
        songs: songs.map((song) => song.title),
        files: files.map((f) => f.path.replace(/^.*[\\/]/, '')).slice(0, 10),
      });
      return;
    }
    // 'auto' copies or moves as Lidarr would for its own download.
    await api.manualImport(
      'auto',
      picked.map((file) => ({
        path: file.path,
        artistId: item.artistId,
        albumId: item.albumId,
        albumReleaseId: release.id,
        trackIds: [file.trackId],
        quality: file.quality ?? {
          quality: { id: 0, name: 'Unknown' },
          revision: { version: 1, real: 0, isRepack: false },
        },
        indexerFlags: 0,
        disableReleaseSwitching: true,
        downloadId: item.downloadId,
      }))
    );
    logger.info('Imported requested songs from a download Lidarr held back', {
      label: LABEL,
      download: item.title,
      songs: picked.length,
    });
  }
}

const blockedImports = new BlockedImports();
export default blockedImports;
