import { musicBrainz } from '@server/api/musicbrainz';
import type LidarrAPI from '@server/api/servarr/lidarr';
import { MediaRequestStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import SongRequest from '@server/entity/SongRequest';
import { lidarrApi } from '@server/lib/music/access';
import { albumFor, toVersion } from '@server/lib/music/songs';
import type { LidarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { In, IsNull, Not } from 'typeorm';

/*
 * A song is fetched through its single when it had one, as Lidarr fetches
 * any album. Older singles are seldom posted on their own (Usenet has the
 * albums), so Lidarr often finds no release at all. Then the song is taken
 * from one of the artist's albums with it instead (lib/music/songFetch), at
 * once: Lidarr is asked to search for the single, and when that search
 * ends with nothing grabbed, the song moves to the album.
 */

const LABEL = 'Song Fetch';

/** Searches started a minute, so many singles don't flood the indexers. */
const SEARCHES_AT_ONCE = 3;
/** A song on no album of the artist's isn't looked up again for this long. */
const NO_ALBUM_AGAIN_MS = 6 * 60 * 60_000;

/** Lidarr's states for a command that is over. */
const OVER = ['completed', 'failed', 'aborted', 'cancelled', 'orphaned'];

interface Single {
  server: LidarrSettings;
  lidarrAlbumId: number;
  songs: SongRequest[];
}

class SingleFallback {
  /** The search started for each single, by server and Lidarr album. */
  private searches = new Map<string, number>();
  /** Songs on no album of the artist's, and when that was found. */
  private noAlbum = new Map<string, number>();

  /** Moves songs whose single Lidarr couldn't find to an album. */
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
        if ((album.statistics?.trackFileCount ?? 0) > 0) continue;

        const commandId = this.searches.get(key);
        if (commandId === undefined) {
          if (started >= SEARCHES_AT_ONCE) continue;
          started++;
          this.searches.set(key, await api.startAlbumSearch([album.id]));
          logger.info('Asked Lidarr to search for a single', {
            label: LABEL,
            single: single.songs[0].singleTitle,
            songs: single.songs.length,
          });
          continue;
        }
        const command = await api.getCommand(commandId).catch(() => null);
        if (command && !OVER.includes(command.status)) continue;
        this.searches.delete(key);
        // A search that couldn't run says nothing: searched again later.
        if (command?.status !== 'completed') continue;
        // Grabbed by the search just over: it's on its way.
        if (await inQueue(single, true)) continue;
        await this.toAlbums(api, single, now);
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
   * Each of the single's songs onto the artist's album with that very
   * recording, for the song to be taken from it; and Lidarr no longer
   * looks for the single, unless a song stays on it.
   */
  private async toAlbums(
    api: LidarrAPI,
    single: Single,
    now: number
  ): Promise<void> {
    let staying = 0;
    for (const song of single.songs) {
      const seen = this.noAlbum.get(song.recordingMbid);
      if (seen !== undefined && now - seen < NO_ALBUM_AGAIN_MS) {
        staying++;
        continue;
      }
      const recording = await musicBrainz().getRecording(
        song.recordingMbid,
        'background'
      );
      const version = recording ? toVersion(recording) : null;
      const album = version ? albumFor(version) : null;
      if (!album) {
        this.noAlbum.set(song.recordingMbid, now);
        staying++;
        continue;
      }
      await getRepository(SongRequest).update(song.id, {
        singleMbid: null,
        singleTitle: null,
        sourceAlbumMbid: album.mbId,
        sourceAlbumTitle: album.title,
      });
      logger.info(
        'Lidarr found no release of the single; taking the song from an album',
        {
          label: LABEL,
          song: song.title,
          single: song.singleTitle,
          album: album.title,
        }
      );
    }
    if (!staying) {
      await api.monitorAlbums([single.lidarrAlbumId], false);
    }
  }
}

const singleFallback = new SingleFallback();
export default singleFallback;
