import { torrentClientFor, usenetClientFor } from '@server/api/downloadclients';
import type { FetchedRelease, ProwlarrRelease } from '@server/api/prowlarr';
import ProwlarrAPI, { AUDIO_CATEGORIES } from '@server/api/prowlarr';
import type LidarrAPI from '@server/api/servarr/lidarr';
import type {
  LidarrAlbum,
  LidarrArtist,
  LidarrQualityModel,
  LidarrTrack,
} from '@server/api/servarr/lidarr';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import MusicAlbum from '@server/entity/MusicAlbum';
import type { SongFetchFile } from '@server/entity/SongFetch';
import SongFetch from '@server/entity/SongFetch';
import SongRequest from '@server/entity/SongRequest';
import { magnetHash, parseTorrent } from '@server/lib/backfill/bencode';
import backfill, { mapRemotePath } from '@server/lib/backfill/engine';
import {
  IndexerLimitReached,
  PROWLARR,
  indexerLimits,
} from '@server/lib/backfill/indexerLimit';
import { lidarrApi, musicReady } from '@server/lib/music/access';
import {
  fileForTrack,
  isAudio,
  namesAlbum,
} from '@server/lib/music/albumRelease';
import { refreshArtists } from '@server/lib/music/availability';
import { clientFor, songFetchProblem } from '@server/lib/music/songFetchReady';
import { releaseForSongs } from '@server/lib/music/songRelease';
import { normalizeTitle } from '@server/lib/music/songs';
import { markUndispatchable } from '@server/lib/requestDispatch';
import type {
  DownloadClientSettings,
  LidarrSettings,
} from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { In, IsNull, Not } from 'typeorm';

/*
 * Songs only on albums, taken from them (Settings → Music, "Take songs
 * from albums"). For each album songs are asked for from:
 *
 * 1. Lidarr: the artist is added if it is new (nothing of theirs
 *    monitored), and the album too, unmonitored, so Lidarr lists its
 *    tracks and never goes looking for the rest.
 * 2. A release of the album is searched for through Backfill's Prowlarr:
 *    one whose name is the album's, with a file for each song.
 * 3. It goes to Backfill's download client; a torrent with only the songs'
 *    files picked.
 * 4. Lidarr's manual import takes just those files into their tracks.
 * 5. The download is removed. The music scans then see the songs here, and
 *    the requests are done (lib/music/completion).
 *
 * A song not found, or not taken by Lidarr, is failed with the reason; its
 * request can be retried like any failed request.
 */

const LABEL = 'Song Fetch';

/** Results opened for their file lists, best first. */
const MAX_OPEN = 5;
/** Releases tried before the songs are given up on. */
const MAX_TRIES = 3;
/** Bigger than any album the songs are worth. */
const MAX_RELEASE_BYTES = 4 * 1024 ** 3;
/** How long the swarm may take to send a magnet's file list. */
const METADATA_GIVE_UP_MS = 30 * 60_000;
/** How long Lidarr may take to import. */
const IMPORT_GIVE_UP_MS = 3 * 60 * 60_000;
/** How long Lidarr may take to know the artist and album. */
const LOOKUP_GIVE_UP_MS = 7 * 24 * 60 * 60_000;
/** How long a fetch may keep stumbling on errors before it gives up. */
const STUMBLE_GIVE_UP_MS = 24 * 60 * 60_000;

const ACTIVE: SongFetch['status'][] = [
  'queued',
  'searching',
  'downloading',
  'importing',
];

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A failure that is the release's fault: the next release is tried. */
class ReleaseProblem extends Error {}

const clientById = (id: number | null): DownloadClientSettings => {
  const client = getSettings().downloadClients.find((c) => c.id === id);
  if (!client) throw new Error('The download client was removed from Seerr.');
  return client;
};

/** A song's track in Lidarr's album: its recording, else its title. */
const trackOf = (
  tracks: LidarrTrack[],
  song: Pick<SongRequest, 'recordingMbid' | 'title' | 'version'>
): LidarrTrack | undefined => {
  const byRecording = tracks.find(
    (t) => t.foreignRecordingId === song.recordingMbid
  );
  if (byRecording) return byRecording;
  const named = normalizeTitle(
    song.version ? `${song.title} (${song.version})` : song.title
  );
  return (
    tracks.find((t) => normalizeTitle(t.title) === named) ??
    (song.version
      ? undefined
      : tracks.find(
          (t) => normalizeTitle(t.title) === normalizeTitle(song.title)
        ))
  );
};

class SongFetcher {
  private ticking = false;

  /** Every minute: starts fetches for new songs and moves each along. */
  public async tick(): Promise<void> {
    if (this.ticking || !musicReady() || songFetchProblem()) return;
    this.ticking = true;
    try {
      await this.plan();
      await this.linkFinished();
      await this.correctFinished();
      const fetches = await getRepository(SongFetch).find({
        where: { status: In(ACTIVE) },
        order: { id: 'ASC' },
      });
      for (const fetch of fetches) {
        try {
          await this.advance(fetch);
        } catch (e) {
          await this.stumbled(fetch, e);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** The songs waiting to be taken from an album that no fetch has yet. */
  private async waiting(): Promise<SongRequest[]> {
    return getRepository(SongRequest).find({
      where: {
        status: MediaRequestStatus.APPROVED,
        singleMbid: IsNull(),
        sourceAlbumMbid: Not(IsNull()),
        request: { status: MediaRequestStatus.APPROVED },
      },
      relations: { request: { media: true } },
    });
  }

  /** One fetch for each album songs are waiting for. */
  private async plan(): Promise<void> {
    const songs = await this.waiting();
    if (!songs.length) return;
    // One under way, or done (its songs then wait for the music scans to
    // see them here), already has them.
    const active = await getRepository(SongFetch).find({
      where: { status: In([...ACTIVE, 'done']) },
    });
    const taken = new Set(
      active.flatMap((fetch) =>
        fetch.recordings.map((id) => `${fetch.albumMbid}:${id}`)
      )
    );
    const byAlbum = new Map<string, SongRequest[]>();
    for (const song of songs) {
      const key = song.sourceAlbumMbid as string;
      if (taken.has(`${key}:${song.recordingMbid}`)) continue;
      byAlbum.set(key, [...(byAlbum.get(key) ?? []), song]);
    }
    for (const [albumMbid, list] of byAlbum) {
      const { request } = list[0];
      const media = request.media;
      const server = this.lidarrOf(request.serverId);
      if (!server || !media?.foreignId) continue;
      await getRepository(SongFetch).save(
        new SongFetch({
          albumMbid,
          albumTitle: list[0].sourceAlbumTitle ?? albumMbid,
          artistMbid: media.foreignId,
          artistName: media.foreignTitle || media.foreignId,
          recordings: [...new Set(list.map((song) => song.recordingMbid))],
          status: 'queued',
          stage: 'Waiting to start',
          lidarrId: server.id,
          files: [],
          tried: [],
        })
      );
      logger.info('Taking songs from an album', {
        label: LABEL,
        album: albumMbid,
        songs: list.length,
      });
    }
  }

  private lidarrOf(serverId?: number | null): LidarrSettings | undefined {
    const servers = getSettings().lidarr;
    return (
      servers.find((s) => serverId != null && s.id === serverId) ??
      servers.find((s) => s.isDefault)
    );
  }

  private lidarr(fetch: SongFetch): LidarrAPI {
    const server = getSettings().lidarr.find((s) => s.id === fetch.lidarrId);
    if (!server) throw new Error('Its Lidarr server was removed from Seerr.');
    return lidarrApi(server);
  }

  /** The tracks of the release the songs go into. */
  private tracksOf(
    lidarr: LidarrAPI,
    fetch: SongFetch
  ): Promise<LidarrTrack[]> {
    return fetch.lidarrReleaseId
      ? lidarr.getReleaseTracks(fetch.lidarrReleaseId)
      : lidarr.getTracks(fetch.lidarrAlbumId!);
  }

  /** The songs it is for that are still asked for, approved. */
  private async songsOf(fetch: SongFetch): Promise<SongRequest[]> {
    if (!fetch.recordings.length) return [];
    return getRepository(SongRequest).find({
      where: {
        recordingMbid: In(fetch.recordings),
        sourceAlbumMbid: fetch.albumMbid,
        status: MediaRequestStatus.APPROVED,
        request: { status: MediaRequestStatus.APPROVED },
      },
      relations: { request: { media: true } },
    });
  }

  private async advance(fetch: SongFetch): Promise<void> {
    const songs = await this.songsOf(fetch);
    if (!songs.length) {
      await this.removeDownload(fetch).catch(() => undefined);
      await this.end(
        fetch,
        'failed',
        'Its songs are no longer asked for: declined, removed or done.'
      );
      return;
    }
    if (
      fetch.status === 'queued' &&
      Date.now() - fetch.createdAt.getTime() > LOOKUP_GIVE_UP_MS
    ) {
      await this.failSongs(
        songs,
        `Lidarr couldn’t look up ${fetch.albumTitle} for a week. Retry later.`
      );
      await this.end(fetch, 'failed', 'Lidarr could not look up the album.');
      return;
    }
    switch (fetch.status) {
      case 'queued':
        await this.prepare(fetch, songs);
        return;
      case 'searching':
        await this.search(fetch, songs);
        return;
      case 'downloading':
        await this.follow(fetch, songs);
        return;
      case 'importing':
        await this.followImport(fetch, songs);
        return;
    }
  }

  /**
   * Lidarr has the artist and the album (unmonitored), and knows which of
   * its tracks each song is. Songs Lidarr has a file for already are left
   * to the music scans.
   */
  private async prepare(fetch: SongFetch, songs: SongRequest[]): Promise<void> {
    const lidarr = this.lidarr(fetch);
    const server = getSettings().lidarr.find((s) => s.id === fetch.lidarrId)!;
    let artist = await lidarr.getArtistByMbid(fetch.artistMbid);
    if (!artist) {
      const found = await lidarr.lookupArtist(fetch.artistMbid);
      if (!found) {
        fetch.stage = 'Waiting for Lidarr to look up the artist';
        await getRepository(SongFetch).save(fetch);
        return;
      }
      const request = songs[0].request;
      artist = await lidarr.addArtist(found, {
        qualityProfileId: request.profileId || server.activeProfileId,
        metadataProfileId:
          request.metadataProfileId || server.activeMetadataProfileId,
        rootFolderPath: request.rootFolder || server.activeDirectory,
        tags: [...(request.tags ?? server.tags ?? [])],
        monitored: true,
        monitorNewItems: 'none',
        addOptions: { monitor: 'none', searchForMissingAlbums: false },
      });
      logger.info('Added an artist to take songs from their album', {
        label: LABEL,
        artist: fetch.artistMbid,
      });
      // Lidarr lists the artist's albums itself, the album perhaps among
      // them; it is looked for next time rather than added alongside.
      fetch.lidarrArtistId = artist.id;
      fetch.stage = 'Waiting for Lidarr to list the artist’s albums';
      await getRepository(SongFetch).save(fetch);
      return;
    }
    fetch.lidarrArtistId = artist.id;
    await this.linkArtist(songs[0].request, server, artist);

    let album: LidarrAlbum | undefined = (
      await lidarr.getAlbums({ artistId: artist.id })
    ).find((a) => a.foreignAlbumId === fetch.albumMbid);
    if (!album) {
      const found = await lidarr.lookupAlbum(fetch.albumMbid);
      if (!found) {
        fetch.stage = 'Waiting for Lidarr to look up the album';
        await getRepository(SongFetch).save(fetch);
        return;
      }
      album = await lidarr.addAlbum(found, {
        artist,
        searchForNewAlbum: false,
        monitored: false,
      });
    }
    fetch.lidarrAlbumId = album.id;
    await this.keepAlbumRow(fetch, album, songs[0].request);

    // The release the songs are imported into: one with them on it.
    const release = await releaseForSongs(
      lidarr,
      album.id,
      songs.map((song) => song.recordingMbid)
    );
    if (!release) {
      fetch.stage = 'Waiting for Lidarr to list the album’s releases';
      await getRepository(SongFetch).save(fetch);
      return;
    }
    fetch.lidarrReleaseId = release.id;

    const tracks = await lidarr.getReleaseTracks(release.id);
    if (!tracks.length) {
      fetch.stage = 'Waiting for Lidarr to list the album’s tracks';
      await getRepository(SongFetch).save(fetch);
      return;
    }
    const unknown = songs.filter((song) => !trackOf(tracks, song));
    if (unknown.length) {
      await this.failSongs(
        unknown,
        `Lidarr’s ${fetch.albumTitle} has no “${unknown[0].title}”.`
      );
    }
    // Already on file: the scans will find it here.
    const wanted = songs.filter((song) => {
      const track = trackOf(tracks, song);
      return track && !track.hasFile;
    });
    if (!wanted.length) {
      await this.end(fetch, 'done', null);
      return;
    }
    fetch.status = 'searching';
    fetch.stage = 'Searching for the album';
    await getRepository(SongFetch).save(fetch);
    await this.search(fetch, wanted);
  }

  /**
   * The artist's media row knows which Lidarr has them, as sending an
   * album there records, so the music scans follow the album the songs go
   * into. An artist already on another Lidarr keeps it.
   */
  private async linkArtist(
    request: MediaRequest,
    server: Pick<LidarrSettings, 'id'>,
    artist: Pick<LidarrArtist, 'id' | 'foreignArtistId'>
  ): Promise<void> {
    const media = request.media;
    if (!media?.id || media.externalServiceId != null) return;
    await getRepository(Media).update(media.id, {
      serviceId: server.id,
      externalServiceId: artist.id,
      externalServiceSlug: artist.foreignArtistId || media.foreignId,
    });
    media.serviceId = server.id;
    media.externalServiceId = artist.id;
  }

  /**
   * Songs taken before the artist was linked to their Lidarr (fixed since)
   * wait for scans that never looked at their album: linked now, their
   * requests finish with the next scan. Those already finished are linked
   * too, for the artist's page to reach Lidarr.
   */
  private async linkFinished(): Promise<void> {
    const finished = await getRepository(SongFetch).find({
      where: { status: 'done', lidarrArtistId: Not(IsNull()) },
      order: { id: 'DESC' },
      take: 50,
    });
    for (const fetch of finished) {
      if (!fetch.recordings.length) continue;
      const song = await getRepository(SongRequest).findOne({
        where: {
          recordingMbid: In(fetch.recordings),
          sourceAlbumMbid: fetch.albumMbid,
          request: { status: Not(MediaRequestStatus.DECLINED) },
        },
        relations: { request: { media: true } },
      });
      if (song?.request) {
        await this.linkArtist(
          song.request,
          { id: fetch.lidarrId },
          { id: fetch.lidarrArtistId!, foreignArtistId: fetch.artistMbid }
        );
      }
    }
  }

  /**
   * An album songs were taken from is only partly here until Lidarr has
   * every track of it, whatever the server listing it shows: before this
   * was fixed, such albums were taken as wholly here. Lidarr is asked only
   * while the counts it last gave say the album is not all there.
   */
  private async correctFinished(): Promise<void> {
    const finished = await getRepository(SongFetch).find({
      where: { status: 'done', lidarrAlbumId: Not(IsNull()) },
      order: { id: 'DESC' },
      take: 50,
    });
    const artists = new Set<number>();
    for (const fetch of finished) {
      const row = await getRepository(MusicAlbum).findOne({
        select: {
          id: true,
          mediaId: true,
          status: true,
          trackCount: true,
          trackFileCount: true,
        },
        where: { mbId: fetch.albumMbid },
      });
      if (
        row?.status !== MediaStatus.AVAILABLE ||
        (row.trackCount != null &&
          row.trackFileCount != null &&
          row.trackFileCount >= row.trackCount)
      ) {
        continue;
      }
      try {
        const album = await this.lidarr(fetch).getAlbum(fetch.lidarrAlbumId!);
        const files = album.statistics?.trackFileCount ?? 0;
        const tracks = Math.max(
          album.statistics?.trackCount ?? 0,
          album.statistics?.totalTrackCount ?? 0
        );
        const changes: Partial<MusicAlbum> = {
          trackCount: tracks,
          trackFileCount: files,
        };
        if (files > 0 && files < tracks) {
          changes.status = MediaStatus.PARTIALLY_AVAILABLE;
          artists.add(row.mediaId);
        }
        await getRepository(MusicAlbum).update(row.id, changes);
      } catch (e) {
        // Lidarr not answering: the next run asks again.
        logger.debug('Could not check an album songs were taken from', {
          label: LABEL,
          album: fetch.albumTitle,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
      }
    }
    if (artists.size) await refreshArtists(artists);
  }

  /**
   * The album's row on the artist, with Lidarr's id, so the music scans
   * follow it and the songs can be checked off once their files are in.
   * Not asked for: it stays unknown until the scans see some of it here.
   */
  private async keepAlbumRow(
    fetch: SongFetch,
    album: LidarrAlbum,
    request: MediaRequest
  ): Promise<void> {
    const albums = getRepository(MusicAlbum);
    const row = await albums.findOne({
      where: { mediaId: request.media.id, mbId: fetch.albumMbid },
    });
    if (row) {
      if (row.lidarrAlbumId !== album.id) {
        await albums.update(row.id, { lidarrAlbumId: album.id });
      }
      return;
    }
    await albums.insert(
      new MusicAlbum({
        mediaId: request.media.id,
        mbId: fetch.albumMbid,
        title: fetch.albumTitle,
        primaryType: album.albumType ?? 'Album',
        secondaryTypes: album.secondaryTypes ?? [],
        releaseDate: null,
        status: MediaStatus.UNKNOWN,
        lidarrAlbumId: album.id,
      })
    );
  }

  /**
   * A release of the album with a file for the songs: its name is the
   * album's, and each song's file is found by its name. The best of a few
   * opened is downloaded; with none, the songs fail.
   */
  private async search(fetch: SongFetch, songs: SongRequest[]): Promise<void> {
    const lidarr = this.lidarr(fetch);
    const tracks = await this.tracksOf(lidarr, fetch);
    // Those Lidarr has no file for yet.
    const wanted = songs
      .map((song) => ({ song, track: trackOf(tracks, song) }))
      .filter(
        (w): w is { song: SongRequest; track: LidarrTrack } =>
          !!w.track && !w.track.hasFile
      );
    if (!wanted.length) {
      await this.end(fetch, 'done', null);
      return;
    }
    const prowlarr = new ProwlarrAPI(getSettings().backfill.prowlarr);
    const found = new Map<string, ProwlarrRelease>();
    for (const term of [
      `${fetch.artistName} ${fetch.albumTitle}`,
      fetch.albumTitle,
    ]) {
      try {
        for (const release of await indexerLimits.guard(
          PROWLARR,
          'search',
          () => prowlarr.search(term, { categories: AUDIO_CATEGORIES })
        )) {
          found.set(release.infoHash?.toLowerCase() || release.guid, release);
        }
      } catch (e) {
        if (e instanceof IndexerLimitReached) {
          fetch.stage = e.message;
          await getRepository(SongFetch).save(fetch);
          return;
        }
        throw e;
      }
      if (found.size >= MAX_OPEN) break;
    }

    const usable = [...found.values()]
      .filter(
        (release) =>
          !!clientFor(release.protocol) &&
          release.size <= MAX_RELEASE_BYTES &&
          !fetch.tried.includes(release.guid) &&
          !fetch.tried.includes(`hash:${release.infoHash?.toLowerCase()}`) &&
          namesAlbum(release.title, fetch.albumTitle, fetch.artistName)
      )
      .sort(
        (a, b) =>
          // Torrents can download only the songs; then the best seeded.
          Number(b.protocol === 'torrent') - Number(a.protocol === 'torrent') ||
          (b.seeders ?? 0) - (a.seeders ?? 0) ||
          a.size - b.size
      )
      .slice(0, MAX_OPEN);

    let best:
      | {
          release: ProwlarrRelease;
          files: SongFetchFile[];
          hash: string | null;
        }
      | undefined;
    for (const release of usable) {
      try {
        const { files, infoHash, packed } = await backfill.filesOf(release);
        if (packed) continue;
        const picked = wanted.flatMap(({ song, track }) => {
          const file = fileForTrack(files, track.title, fetch.artistName);
          return file
            ? [
                {
                  index: file.index,
                  path: file.path,
                  size: file.size,
                  recordingMbid: song.recordingMbid,
                  trackId: track.id,
                },
              ]
            : [];
        });
        if (picked.length > (best?.files.length ?? 0)) {
          best = { release, files: picked, hash: infoHash };
        }
        if (picked.length === wanted.length) break;
      } catch (e) {
        logger.debug('Could not read a release of an album', {
          label: LABEL,
          release: release.title,
          errorMessage: message(e),
        });
      }
    }

    const needed = wanted.map((w) => w.song);
    if (!best) {
      await this.failSongs(
        needed,
        `No release of ${fetch.albumTitle} with “${needed[0].title}” was found.`
      );
      await this.end(fetch, 'failed', 'No release with the songs was found.');
      return;
    }
    const missed = needed.filter(
      (song) =>
        !best!.files.some((file) => file.recordingMbid === song.recordingMbid)
    );
    if (missed.length) {
      await this.failSongs(
        missed,
        `No release of ${fetch.albumTitle} had “${missed[0].title}”.`
      );
    }

    const { release } = best;
    fetch.release = {
      guid: release.guid,
      title: release.title,
      indexer: release.indexer,
      indexerId: release.indexerId,
      protocol: release.protocol,
      size: release.size,
      downloadUrl: release.downloadUrl,
      magnetUrl: release.magnetUrl,
      infoHash: best.hash ?? release.infoHash?.toLowerCase(),
    };
    fetch.files = best.files;
    await this.start(fetch);
  }

  /** Adds the release to Backfill's download client. */
  private async start(fetch: SongFetch): Promise<void> {
    const release = fetch.release!;
    const client = clientFor(release.protocol);
    if (!client) {
      throw new Error(
        `No ${release.protocol === 'torrent' ? 'torrent' : 'Usenet'} client is chosen in Settings → Backfill.`
      );
    }
    const running = await getRepository(SongFetch).count({
      where: { id: Not(fetch.id), status: 'downloading' },
    });
    if (running >= getSettings().backfill.maxActiveJobs) {
      fetch.stage = 'Waiting for another song download to finish';
      await getRepository(SongFetch).save(fetch);
      return;
    }
    const category = getSettings().backfill.category;
    let fetched: FetchedRelease;
    try {
      fetched = await indexerLimits.guard(
        { id: release.indexerId, name: release.indexer },
        'download',
        () =>
          new ProwlarrAPI(getSettings().backfill.prowlarr).fetchRelease({
            ...release,
            infoHash: release.infoHash,
          })
      );
    } catch (e) {
      if (e instanceof IndexerLimitReached) {
        fetch.stage = e.message;
        await getRepository(SongFetch).save(fetch);
        return;
      }
      throw new ReleaseProblem(`${release.indexer}: ${message(e)}`);
    }
    fetch.clientId = client.id;
    if (release.protocol === 'torrent') {
      const torrents = torrentClientFor(client);
      if (fetched.kind === 'nzb') {
        throw new ReleaseProblem('Expected a torrent, got an NZB.');
      }
      const hash =
        fetched.kind === 'torrent'
          ? parseTorrent(fetched.data).infoHash
          : magnetHash(fetched.uri);
      if (!hash) throw new ReleaseProblem('The torrent has no info hash.');
      if (await torrents.findTorrent(hash)) {
        throw new ReleaseProblem(`The torrent is already in ${client.name}.`);
      }
      await torrents.ensureCategory(category);
      await torrents.addTorrent(
        fetched.kind === 'torrent'
          ? { torrent: fetched.data, category }
          : { magnet: fetched.uri, category, metadataOnly: true }
      );
      fetch.downloadId = hash;
      fetch.stage = 'Choosing the songs’ files';
    } else {
      if (fetched.kind !== 'nzb') throw new ReleaseProblem('Expected an NZB.');
      fetch.downloadId = await usenetClientFor(client).addNzb(
        fetched.data,
        release.title,
        category
      );
      fetch.stage = 'Queued';
    }
    fetch.status = 'downloading';
    fetch.startedAt = new Date();
    await getRepository(SongFetch).save(fetch);
    if (release.protocol === 'torrent') {
      await this.pickFiles(fetch);
    }
  }

  /** Skips every file of the torrent but the songs', then starts it. */
  private async pickFiles(fetch: SongFetch): Promise<boolean> {
    const torrents = torrentClientFor(clientById(fetch.clientId));
    const files = await torrents.getFiles(fetch.downloadId!);
    if (!files.length) return false;
    const at = fetch.files.map((file) => {
      const same = files.find((f) => f.index === file.index);
      if (same && same.size === file.size) return same.index;
      const name = file.path.replace(/\\/g, '/').split('/').pop();
      return files.find(
        (f) =>
          f.size === file.size &&
          f.name.replace(/\\/g, '/').split('/').pop() === name
      )?.index;
    });
    if (at.some((index) => index === undefined)) {
      throw new ReleaseProblem('The torrent’s files are not the ones read.');
    }
    fetch.files = fetch.files.map((file, i) => ({ ...file, index: at[i]! }));
    const wanted = new Set(fetch.files.map((file) => file.index));
    await torrents.setFilePriority(
      fetch.downloadId!,
      files.filter((f) => !wanted.has(f.index)).map((f) => f.index),
      0
    );
    await torrents.setFilePriority(fetch.downloadId!, [...wanted], 1);
    await torrents.startTorrent(fetch.downloadId!);
    fetch.stage = 'Downloading';
    await getRepository(SongFetch).save(fetch);
    return true;
  }

  /** Follows the download; once the songs' files are in, imports them. */
  private async follow(fetch: SongFetch, songs: SongRequest[]): Promise<void> {
    if (!fetch.downloadId) {
      await this.start(fetch);
      return;
    }
    const client = clientById(fetch.clientId);
    const lidarr = this.lidarr(fetch);
    const mappings = await lidarr.getRemotePathMappings();
    const lidarrPath = (path: string) =>
      mapRemotePath(path, client.hostname, mappings);

    let paths: Map<number, string> | undefined;
    if (fetch.release?.protocol === 'torrent') {
      const torrents = torrentClientFor(client);
      const torrent = await torrents.findTorrent(fetch.downloadId);
      if (!torrent) {
        throw new ReleaseProblem(`The torrent is no longer in ${client.name}.`);
      }
      if (fetch.stage === 'Choosing the songs’ files') {
        if (!(await this.pickFiles(fetch))) {
          if (
            fetch.startedAt &&
            Date.now() - fetch.startedAt.getTime() > METADATA_GIVE_UP_MS
          ) {
            throw new ReleaseProblem('The swarm never sent the file list.');
          }
          return;
        }
      }
      if (torrent.state === 'error') {
        throw new ReleaseProblem(
          `${torrents.product} reports a problem with the torrent: ${torrent.error ?? 'an error'}.`
        );
      }
      const files = await torrents.getFiles(fetch.downloadId);
      const chosen = files.filter((f) =>
        fetch.files.some((file) => file.index === f.index)
      );
      const done = chosen.length > 0 && chosen.every((f) => f.progress >= 1);
      if (!done || torrent.state === 'moving') {
        const have = chosen.reduce((n, f) => n + f.size * f.progress, 0);
        const all = chosen.reduce((n, f) => n + f.size, 0) || 1;
        fetch.stage = `Downloading, ${Math.floor((have / all) * 100)}%`;
        await this.stalled(fetch, have);
        return;
      }
      await torrents.stopTorrent(fetch.downloadId).catch(() => undefined);
      const save = torrent.savePath.replace(/[\\/]+$/, '');
      const sep = save.includes('\\') ? '\\' : '/';
      paths = new Map(
        chosen.map((f) => [
          f.index,
          lidarrPath(`${save}${sep}${f.name.replace(/[\\/]/g, sep)}`),
        ])
      );
    } else {
      const usenet = usenetClientFor(client);
      const job = await usenet.getJob(fetch.downloadId);
      if (!job) {
        throw new ReleaseProblem(`The job is no longer in ${client.name}.`);
      }
      if (job.place !== 'history') {
        fetch.stage = `Downloading, ${Math.floor(job.percentage)}%`;
        await getRepository(SongFetch).save(fetch);
        return;
      }
      if (/^failed$/i.test(job.status)) {
        throw new ReleaseProblem(
          `${usenet.product} could not finish it: ${job.failMessage ?? 'failed'}`
        );
      }
      if (!/^completed$/i.test(job.status) || !job.storage) {
        fetch.stage = `${usenet.product} is finishing it`;
        await getRepository(SongFetch).save(fetch);
        return;
      }
      // Lidarr reads the finished folder; each song's file by its name.
      const seen = await lidarr.getManualImport(
        lidarrPath(job.storage),
        fetch.lidarrArtistId!
      );
      paths = new Map();
      for (const file of fetch.files) {
        const name = file.path.replace(/\\/g, '/').split('/').pop();
        const match = seen.find(
          (s) => s.path.replace(/\\/g, '/').split('/').pop() === name
        );
        if (match) paths.set(file.index, match.path);
      }
    }
    await this.importFiles(fetch, songs, paths);
  }

  /**
   * A torrent that gains nothing for Backfill's stall time is given up,
   * and the next release tried.
   */
  private async stalled(fetch: SongFetch, have: number): Promise<void> {
    const hours = getSettings().backfill.stallHours;
    const seen = this.gains.get(fetch.id);
    if (!seen || have > seen.have) {
      this.gains.set(fetch.id, { have, at: Date.now() });
    } else if (hours > 0 && Date.now() - seen.at > hours * 60 * 60_000) {
      this.gains.delete(fetch.id);
      throw new ReleaseProblem(
        `Nothing downloaded for ${hours} hour${hours === 1 ? '' : 's'}.`
      );
    }
    await getRepository(SongFetch).save(fetch);
  }

  private gains = new Map<number, { have: number; at: number }>();

  /** Hands the songs' files to Lidarr's manual import, track by track. */
  private async importFiles(
    fetch: SongFetch,
    songs: SongRequest[],
    paths: Map<number, string>
  ): Promise<void> {
    const lidarr = this.lidarr(fetch);
    const album = await lidarr.getAlbum(fetch.lidarrAlbumId!);
    const release =
      album.releases?.find((r) => r.id === fetch.lidarrReleaseId) ??
      album.releases?.find((r) => r.monitored) ??
      album.releases?.[0];
    if (!release) throw new Error('Lidarr lists no release of the album.');
    const ready = fetch.files.filter(
      (file) => paths.has(file.index) && isAudio(paths.get(file.index)!)
    );
    // Of those it was downloading.
    const lost = songs.filter(
      (song) =>
        fetch.files.some((file) => file.recordingMbid === song.recordingMbid) &&
        !ready.some((file) => file.recordingMbid === song.recordingMbid)
    );
    if (lost.length) {
      await this.failSongs(
        lost,
        `“${lost[0].title}” was not in the finished download.`
      );
    }
    if (!ready.length) {
      await this.end(fetch, 'failed', 'Nothing in the download to import.');
      return;
    }
    // Each file's quality as Lidarr reads it, for its own folder.
    const qualities = new Map<string, LidarrQualityModel>();
    for (const folder of new Set(
      ready.map((file) => paths.get(file.index)!.replace(/[\\/][^\\/]*$/, ''))
    )) {
      for (const item of await lidarr
        .getManualImport(folder, fetch.lidarrArtistId!)
        .catch(() => [])) {
        if (item.quality) qualities.set(item.path, item.quality);
      }
    }
    fetch.commandId = await lidarr.manualImport(
      ready.map((file) => {
        const path = paths.get(file.index)!;
        return {
          path,
          artistId: fetch.lidarrArtistId!,
          albumId: fetch.lidarrAlbumId!,
          albumReleaseId: release.id,
          trackIds: [file.trackId],
          quality: qualities.get(path) ?? {
            quality: { id: 0, name: 'Unknown' },
            revision: { version: 1, real: 0, isRepack: false },
          },
          indexerFlags: 0,
          disableReleaseSwitching: true,
        };
      })
    );
    fetch.files = ready;
    fetch.status = 'importing';
    fetch.stage = 'Lidarr is importing the songs';
    await getRepository(SongFetch).save(fetch);
  }

  /** Once Lidarr's import is over: what landed, and the download removed. */
  private async followImport(
    fetch: SongFetch,
    songs: SongRequest[]
  ): Promise<void> {
    const lidarr = this.lidarr(fetch);
    if (fetch.commandId) {
      const command = await lidarr
        .getCommand(fetch.commandId)
        .catch(() => null);
      const over =
        !command ||
        ['completed', 'failed', 'aborted', 'cancelled', 'orphaned'].includes(
          command.status
        );
      if (!over && Date.now() - fetch.updatedAt.getTime() < IMPORT_GIVE_UP_MS) {
        return;
      }
    }
    const tracks = await this.tracksOf(lidarr, fetch);
    const landed = fetch.files.filter(
      (file) => tracks.find((t) => t.id === file.trackId)?.hasFile
    );
    const refused = songs.filter(
      (song) =>
        fetch.files.some((file) => file.recordingMbid === song.recordingMbid) &&
        !landed.some((file) => file.recordingMbid === song.recordingMbid)
    );
    if (refused.length) {
      await this.failSongs(
        refused,
        `Lidarr did not import “${refused[0].title}” from ${fetch.albumTitle}.`
      );
    }
    if (landed.length) {
      // Only the songs were wanted; the rest of the download goes.
      await this.removeDownload(fetch).catch((e) =>
        logger.warn('Could not remove a finished song download', {
          label: LABEL,
          fetchId: fetch.id,
          errorMessage: message(e),
        })
      );
      logger.info('Took songs from an album', {
        label: LABEL,
        album: fetch.albumMbid,
        songs: landed.length,
      });
    }
    await this.end(
      fetch,
      landed.length ? 'done' : 'failed',
      landed.length ? null : 'Lidarr imported none of the songs.'
    );
  }

  /** Marks songs failed, and each request they are in, with why. */
  private async failSongs(songs: SongRequest[], reason: string): Promise<void> {
    if (!songs.length) return;
    await getRepository(SongRequest).update(
      { id: In(songs.map((song) => song.id)) },
      { status: MediaRequestStatus.FAILED }
    );
    const requests = new Map(songs.map((song) => [song.request.id, song]));
    for (const song of requests.values()) {
      const request = await getRepository(MediaRequest).findOne({
        where: { id: song.request.id },
        relations: { media: true },
      });
      if (request && request.status === MediaRequestStatus.APPROVED) {
        await markUndispatchable(request, reason);
      }
    }
  }

  /** Something went wrong: the release's fault, or to be tried again. */
  private async stumbled(fetch: SongFetch, e: unknown): Promise<void> {
    if (e instanceof ReleaseProblem) {
      await this.removeDownload(fetch).catch(() => undefined);
      if (fetch.release) {
        fetch.tried = [
          ...fetch.tried,
          fetch.release.guid,
          ...(fetch.release.infoHash ? [`hash:${fetch.release.infoHash}`] : []),
        ];
      }
      logger.info('A release for songs failed; trying another', {
        label: LABEL,
        fetchId: fetch.id,
        errorMessage: message(e),
      });
      if (
        fetch.tried.filter((key) => !key.startsWith('hash:')).length >=
        MAX_TRIES
      ) {
        const songs = await this.songsOf(fetch);
        await this.failSongs(
          songs,
          `No release of ${fetch.albumTitle} could be downloaded: ${message(e)}`
        );
        await this.end(fetch, 'failed', message(e));
        return;
      }
      Object.assign(fetch, {
        status: 'searching',
        stage: `Looking for another release: ${message(e)}`,
        release: null,
        files: [],
        downloadId: null,
        clientId: null,
        commandId: null,
        startedAt: null,
      });
      await getRepository(SongFetch).save(fetch);
      return;
    }
    logger.warn('Could not take songs from an album yet', {
      label: LABEL,
      fetchId: fetch.id,
      errorMessage: message(e),
    });
    if (Date.now() - fetch.createdAt.getTime() > STUMBLE_GIVE_UP_MS) {
      const songs = await this.songsOf(fetch);
      await this.failSongs(songs, message(e));
      await this.end(fetch, 'failed', message(e));
      return;
    }
    fetch.stage = `Trying again: ${message(e)}`.slice(0, 250);
    await getRepository(SongFetch).save(fetch);
  }

  private async removeDownload(fetch: SongFetch): Promise<void> {
    if (!fetch.downloadId || fetch.clientId == null) return;
    const client = clientById(fetch.clientId);
    if (fetch.release?.protocol === 'torrent') {
      await torrentClientFor(client).deleteTorrent(fetch.downloadId);
    } else {
      await usenetClientFor(client).deleteJob(fetch.downloadId);
    }
  }

  private async end(
    fetch: SongFetch,
    status: 'done' | 'failed',
    error: string | null
  ): Promise<void> {
    this.gains.delete(fetch.id);
    fetch.status = status;
    fetch.error = error?.slice(0, 250) ?? null;
    fetch.stage = null;
    fetch.finishedAt = new Date();
    await getRepository(SongFetch).save(fetch);
  }
}

const songFetcher = new SongFetcher();
export default songFetcher;

/** Where each song taken from an album stands, for its request's card. */
export const songFetchStages = async (
  songs: Pick<SongRequest, 'recordingMbid' | 'sourceAlbumMbid'>[]
): Promise<Map<string, string>> => {
  const albums = [
    ...new Set(
      songs.flatMap((song) =>
        song.sourceAlbumMbid ? [song.sourceAlbumMbid] : []
      )
    ),
  ];
  const stages = new Map<string, string>();
  if (!albums.length) return stages;
  const fetches = await getRepository(SongFetch).find({
    where: { albumMbid: In(albums), status: In(ACTIVE) },
  });
  for (const fetch of fetches) {
    for (const recording of fetch.recordings) {
      if (fetch.stage) {
        stages.set(`${fetch.albumMbid}:${recording}`, fetch.stage);
      }
    }
  }
  return stages;
};
