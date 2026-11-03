import { musicBrainz } from '@server/api/musicbrainz';
import type LidarrAPI from '@server/api/servarr/lidarr';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import AlbumRequest from '@server/entity/AlbumRequest';
import MusicAlbum from '@server/entity/MusicAlbum';
import SongRequest from '@server/entity/SongRequest';
import { lidarrApi } from '@server/lib/music/access';
import { trackOf } from '@server/lib/music/songFetch';
import { albumFor, toVersion } from '@server/lib/music/songs';
import type { LidarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { In, IsNull, Not } from 'typeorm';

/*
 * A song is fetched through its single when it had one, as Lidarr fetches
 * any album. Older singles are seldom posted on their own (Usenet has the
 * albums), so Lidarr often finds no release at all. Then Seerr takes the
 * song itself (lib/music/songFetch), at once: Lidarr is asked to search for
 * the single once, and when that search ends with nothing grabbed, the song
 * is taken from one of the artist's albums with it, or else from the single,
 * Seerr's own searches looking again on their schedule.
 */

const LABEL = 'Song Fetch';

/** Searches started a minute, so many singles don't flood the indexers. */
const SEARCHES_AT_ONCE = 3;

/** Lidarr's states for a command that is over. */
const OVER = ['completed', 'failed', 'aborted', 'cancelled', 'orphaned'];

interface Single {
  server: LidarrSettings;
  lidarrAlbumId: number;
  songs: SongRequest[];
}

/**
 * How long after Lidarr's search ends a grab may take to show in its
 * queue: the songs aren't handed on before, or both would download them.
 */
const QUEUE_SETTLE_MS = 2 * 60_000;
/** A search Lidarr couldn't run, or lost, is asked for again after this. */
const SEARCH_RETRY_MS = 60 * 60_000;

/** Where Lidarr's one search for a single stands. */
interface Search {
  commandId?: number;
  /** When the search ended with nothing grabbed. */
  endedAt?: number;
  /** Not asked for again before then. */
  retryAt?: number;
}

class SingleFallback {
  /** Lidarr's search for each single, by server and Lidarr album. */
  private searches = new Map<string, Search>();

  /** Hands songs whose single Lidarr couldn't find to Seerr's song fetch. */
  public async run(now = Date.now()): Promise<void> {
    const singles = await this.waiting();
    if (!singles.length) {
      this.searches.clear();
      return;
    }
    const queues = new Map<number, Set<number>>();
    const inQueue = async (single: Single, fresh = false) => {
      if (fresh || !queues.has(single.server.id)) {
        const queue = await lidarrApi(single.server).getMusicQueue();
        queues.set(single.server.id, new Set(queue.map((i) => i.albumId)));
      }
      return queues.get(single.server.id)!.has(single.lidarrAlbumId);
    };
    let started = 0;
    const live = new Set<string>();
    for (const single of singles) {
      const key = `${single.server.id}:${single.lidarrAlbumId}`;
      live.add(key);
      const api = lidarrApi(single.server);
      try {
        // On its way, or here and waiting for the music scans.
        if (await inQueue(single)) {
          this.searches.delete(key);
          continue;
        }
        const album = await api.getAlbum(single.lidarrAlbumId);
        // Lidarr has part of the single: what it has waits for the scans,
        // and what it hasn't it won't fetch, so Seerr takes it.
        if ((album.statistics?.trackFileCount ?? 0) > 0) {
          const tracks = await api.getTracks(album.id);
          const missing = single.songs.filter(
            (song) => !trackOf(tracks, song)?.hasFile
          );
          if (missing.length) {
            await this.handOn(api, { ...single, songs: missing }, 'partly');
          }
          this.searches.delete(key);
          continue;
        }

        const search = this.searches.get(key) ?? {};
        this.searches.set(key, search);
        if (search.endedAt !== undefined) {
          // Not handed on before Lidarr's queue could list a grab.
          if (now - search.endedAt < QUEUE_SETTLE_MS) continue;
          if (await inQueue(single, true)) {
            this.searches.delete(key);
            continue;
          }
          if (await this.handOn(api, single)) this.searches.delete(key);
          continue;
        }
        if (search.commandId === undefined) {
          if (search.retryAt !== undefined && now < search.retryAt) continue;
          if (started >= SEARCHES_AT_ONCE) continue;
          started++;
          search.commandId = await api.startAlbumSearch([album.id]);
          search.retryAt = undefined;
          logger.info('Asked Lidarr to search for a single', {
            label: LABEL,
            single: single.songs[0].singleTitle,
            songs: single.songs.length,
          });
          continue;
        }
        const command = await api
          .getCommand(search.commandId)
          .catch(() => null);
        if (command && !OVER.includes(command.status)) continue;
        search.commandId = undefined;
        // A search that couldn't run, or that Lidarr no longer knows of
        // (restarted), says nothing: asked for again later, not at once.
        if (command?.status !== 'completed') {
          search.retryAt = now + SEARCH_RETRY_MS;
          continue;
        }
        search.endedAt = now;
      } catch (e) {
        logger.debug('Could not check a single Lidarr is looking for', {
          label: LABEL,
          lidarrAlbumId: single.lidarrAlbumId,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
      }
    }
    for (const key of this.searches.keys()) {
      if (!live.has(key)) this.searches.delete(key);
    }
  }

  /**
   * Songs on their way through singles Lidarr lists, by single: Lidarr's
   * own albums of each artist say which, the music scans needn't have
   * caught up. A request one of whose songs failed still has the others
   * on their way.
   */
  private async waiting(): Promise<Single[]> {
    const songs = await getRepository(SongRequest).find({
      where: {
        status: MediaRequestStatus.APPROVED,
        singleMbid: Not(IsNull()),
        request: {
          status: In([MediaRequestStatus.APPROVED, MediaRequestStatus.FAILED]),
        },
      },
      relations: { request: { media: true } },
    });
    if (!songs.length) return [];
    const servers = getSettings().lidarr;
    const albumsOf = new Map<string, Map<string, number>>();
    const singles = new Map<string, Single>();
    for (const song of songs) {
      const server =
        servers.find((s) => s.id === song.request.serverId) ??
        servers.find((s) => s.isDefault);
      const artistMbid = song.request.media?.foreignId;
      // Searches are left alone where Lidarr is told not to search.
      if (!server || server.preventSearch || !artistMbid) continue;
      const artistKey = `${server.id}:${artistMbid}`;
      let albums = albumsOf.get(artistKey);
      if (!albums) {
        const api = lidarrApi(server);
        const artist = await api.getArtistByMbid(artistMbid).catch(() => null);
        albums = new Map(
          artist
            ? (await api.getAlbums({ artistId: artist.id })).map((album) => [
                album.foreignAlbumId,
                album.id,
              ])
            : []
        );
        albumsOf.set(artistKey, albums);
      }
      const lidarrAlbumId = albums.get(song.singleMbid!);
      // Not listed by Lidarr yet: its request is still being sent.
      if (lidarrAlbumId === undefined) continue;
      const key = `${server.id}:${lidarrAlbumId}`;
      const single = singles.get(key) ?? { server, lidarrAlbumId, songs: [] };
      single.songs.push(song);
      singles.set(key, single);
    }
    return [...singles.values()];
  }

  /**
   * Each of the single's songs to Seerr's song fetch: taken from the
   * artist's album with that very recording, or from the single itself when
   * no album has it. Lidarr no longer looks for the single, and a single
   * nobody else is waiting for is no longer counted as on its way (it would
   * keep its other songs from being asked for). False while a song's
   * recording couldn't be looked up, for it to be tried again.
   */
  private async handOn(
    api: LidarrAPI,
    single: Single,
    why: 'none' | 'partly' = 'none'
  ): Promise<boolean> {
    const singleMbid = single.songs[0]?.singleMbid;
    let left = 0;
    for (const song of single.songs) {
      let recording;
      try {
        recording = await musicBrainz().getRecording(
          song.recordingMbid,
          'background'
        );
      } catch (e) {
        left++;
        logger.debug('Could not look up a song Lidarr found no single for', {
          label: LABEL,
          song: song.title,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
      const version = recording ? toVersion(recording) : null;
      const album = version ? albumFor(version) : null;
      await getRepository(SongRequest).update(song.id, {
        singleMbid: null,
        singleTitle: null,
        sourceAlbumMbid: album?.mbId ?? song.singleMbid,
        sourceAlbumTitle: album?.title ?? song.singleTitle,
      });
      logger.info(
        why === 'partly'
          ? 'Lidarr has only part of the single; Seerr is taking the song'
          : album
            ? 'Lidarr found no release of the single; taking the song from an album'
            : 'Lidarr found no release of the single; Seerr is looking for it instead',
        {
          label: LABEL,
          song: song.title,
          single: song.singleTitle,
          ...(album ? { album: album.title } : {}),
        }
      );
    }
    if (left) return false;
    await api.monitorAlbums([single.lidarrAlbumId], false);
    if (singleMbid) await this.release(singleMbid);
    return true;
  }

  /**
   * The single's row back to nobody having asked, when no other song or
   * album request still waits for it and nothing of it is here.
   */
  private async release(singleMbid: string): Promise<void> {
    const open = [MediaRequestStatus.PENDING, MediaRequestStatus.APPROVED];
    const [songs, albums] = await Promise.all([
      getRepository(SongRequest).count({
        where: { singleMbid, status: In(open) },
      }),
      getRepository(AlbumRequest).count({
        where: { albumMbid: singleMbid, status: In(open) },
      }),
    ]);
    if (songs || albums) return;
    const rows = await getRepository(MusicAlbum).find({
      select: { id: true, trackFileCount: true },
      where: {
        mbId: singleMbid,
        status: In([MediaStatus.PENDING, MediaStatus.PROCESSING]),
      },
    });
    const free = rows.filter((row) => !row.trackFileCount);
    if (free.length) {
      await getRepository(MusicAlbum).update(
        { id: In(free.map((row) => row.id)) },
        { status: MediaStatus.UNKNOWN }
      );
    }
  }
}

const singleFallback = new SingleFallback();
export default singleFallback;
