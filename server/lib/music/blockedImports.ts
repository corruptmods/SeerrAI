import type LidarrAPI from '@server/api/servarr/lidarr';
import type {
  LidarrQualityModel,
  LidarrQueueAppend,
} from '@server/api/servarr/lidarr';
import { MediaRequestStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import SongRequest from '@server/entity/SongRequest';
import { lidarrApi } from '@server/lib/music/access';
import { fileForTrack, namesAlbum } from '@server/lib/music/albumRelease';
import { trackOf } from '@server/lib/music/songFetch';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { In } from 'typeorm';

/*
 * Lidarr won't import a download missing some of its edition's tracks: a
 * single's download often has only the song, while every edition of the
 * single also has a radio edit or an instrumental. When such a download
 * has a song someone asked for, it is the song that was wanted: Seerr AI
 * has Lidarr import just that song into its track, and the download is
 * done. What it can't match stays in Lidarr's queue, and the Health page
 * lists it (lib/health).
 */

const LABEL = 'Music Imports';

/** Lidarr's states for a finished download it hasn't imported. */
export const HELD_BACK = ['importBlocked', 'importFailed'];

/**
 * Lidarr's word for the one reason handled here: the download has fewer
 * tracks than the edition. Any other ("album match is not close enough",
 * "unknown artist") may mean it isn't the single at all.
 */
const MISSING_TRACKS = /missing tracks/i;

/** A download already handled isn't tried again for this long. */
const TRY_AGAIN_MS = 60 * 60_000;

type QueueItem = Awaited<ReturnType<LidarrAPI['getMusicQueue']>>[number];

/** A finished download Lidarr is holding back, and why. */
export const heldBack = (
  item: QueueItem
): item is QueueItem & Required<Pick<LidarrQueueAppend, 'outputPath'>> =>
  HELD_BACK.includes(item.trackedDownloadState) && !!item.outputPath;

/** Lidarr's reasons, as one line: "Has missing tracks". */
export const heldBackReason = (item: QueueItem): string =>
  [
    ...new Set(
      (item.statusMessages ?? []).flatMap((status) => status.messages ?? [])
    ),
  ].join(' · ');

class BlockedImports {
  /** When each download was last tried, by download and song. */
  private tried = new Map<string, number>();
  private running = false;

  /** Every Lidarr's queue, once: what can be imported is. */
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
      .filter((item) => MISSING_TRACKS.test(heldBackReason(item)));
    if (!held.length) return;
    const albums = [
      ...new Set(
        held.flatMap((item) =>
          item.album?.foreignAlbumId ? [item.album.foreignAlbumId] : []
        )
      ),
    ];
    if (!albums.length) return;
    // Songs on their way through these singles.
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

  /** The wanted songs' files, each into its own track. */
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
    // Only a download named as this single of this artist.
    if (!namesAlbum(item.title, album.title, artist)) return;
    const files = found.map((file, index) => ({
      index,
      path: file.path,
      // Lidarr not saying is no reason to pass a file over.
      size: file.size ?? Number.MAX_SAFE_INTEGER,
      quality: file.quality,
    }));
    const picked: {
      path: string;
      trackId: number;
      quality?: LidarrQualityModel;
    }[] = [];
    for (const song of songs) {
      const track = trackOf(tracks, song);
      if (!track || track.hasFile) continue;
      const file = fileForTrack(
        files.filter((f) => !picked.some((p) => p.path === f.path)),
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
    if (!picked.length) return;
    await api.manualImport(
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
