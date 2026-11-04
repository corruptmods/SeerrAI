import { torrentClientFor, usenetClientFor } from '@server/api/downloadclients';
import { musicBrainz } from '@server/api/musicbrainz';
import type { FetchedRelease, ProwlarrRelease } from '@server/api/prowlarr';
import ProwlarrAPI, { AUDIO_CATEGORIES } from '@server/api/prowlarr';
import type LidarrAPI from '@server/api/servarr/lidarr';
import type {
  LidarrAlbum,
  LidarrArtist,
  LidarrDelayProfile,
  LidarrQualityModel,
  LidarrTrack,
} from '@server/api/servarr/lidarr';
import type { SlskdResponse } from '@server/api/slskd';
import SlskdAPI, { SlskdRefused, transferIs } from '@server/api/slskd';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import MusicAlbum from '@server/entity/MusicAlbum';
import type { SongFetchFile } from '@server/entity/SongFetch';
import SongFetch from '@server/entity/SongFetch';
import SongRequest from '@server/entity/SongRequest';
import { magnetHash, parseTorrent } from '@server/lib/backfill/bencode';
import backfill from '@server/lib/backfill/engine';
import {
  IndexerLimitReached,
  PROWLARR,
  indexerLimits,
} from '@server/lib/backfill/indexerLimit';
import { nzbWith } from '@server/lib/backfill/nzb';
import { mapRemotePath } from '@server/lib/backfill/paths';
import { torrentStage } from '@server/lib/backfill/progress';
import type { TorrentReading } from '@server/lib/backfill/watchdog';
import { TorrentWatch, swarmLacks } from '@server/lib/backfill/watchdog';
import downloadTracker from '@server/lib/downloadtracker';
import { lidarrApi, musicReady } from '@server/lib/music/access';
import {
  fileForTrack,
  fileInCatalog,
  isAudio,
  namesAlbum,
  namesArtist,
  namesCatalog,
  namesOtherVersion,
} from '@server/lib/music/albumRelease';
import { refreshArtists } from '@server/lib/music/availability';
import singleFallback from '@server/lib/music/singleFallback';
import { clientFor, songFetchProblem } from '@server/lib/music/songFetchReady';
import { SEARCHING_SOON } from '@server/lib/music/songFetchWaits';
import { releaseForSongs } from '@server/lib/music/songRelease';
import type { SongSourceAnswer } from '@server/lib/music/songSources';
import { aiSongSources } from '@server/lib/music/songSources';
import {
  albumsFor,
  normalizeTitle,
  singleFor,
  toVersion,
} from '@server/lib/music/songs';
import {
  chooseSharer,
  mergeResponses,
  soulseekQuery,
} from '@server/lib/music/soulseekSongs';
import { owner } from '@server/lib/owner';
import { markUndispatchable } from '@server/lib/requestDispatch';
import type {
  DownloadClientSettings,
  LidarrSettings,
} from '@server/lib/settings';
import { getSettings, soulseekOf } from '@server/lib/settings';
import logger from '@server/logger';
import { isAxiosError } from 'axios';
import { In, IsNull, Not } from 'typeorm';

/*
 * Songs only on albums, taken from them (Settings → Music, "Take songs
 * from albums"). For each album songs are asked for from:
 *
 * 1. Lidarr: the artist is added if it is new (nothing of theirs
 *    monitored), and the album too, unmonitored, so Lidarr lists its
 *    tracks and never goes looking for the rest.
 * 2. A release of the album is searched for through Backfill's Prowlarr:
 *    one whose name is the album's, with a file for each song. With none,
 *    Soulseek (Settings → Services) is searched for each song, then a pack
 *    of the artist's releases, then what Backfill's second opinion names.
 * 3. It goes to Backfill's download client (a torrent with only the songs'
 *    files picked), or the songs' files alone are asked of a Soulseek
 *    sharer through slskd.
 * 4. Lidarr's manual import takes just those files into their tracks.
 * 5. The download is removed. The music scans then see the songs here, and
 *    the requests are done (lib/music/completion).
 *
 * A song not found, or not taken by Lidarr, is failed with the reason; its
 * request can be retried like any failed request.
 */

const LABEL = 'Song Fetch';

/**
 * Which releases are opened first: whichever of torrents and Usenet
 * Lidarr's delay profile prefers (a torrent can download only the songs;
 * Usenet brings the whole album), then the other; torrents nobody seems to
 * share come last, as they may never finish and their file list can take
 * minutes to come from the swarm.
 */
const releaseTier = (
  release: ProwlarrRelease,
  prefer: LidarrDelayProfile['preferredProtocol']
): number => {
  if (release.protocol === 'torrent' && (release.seeders ?? 1) <= 0) return 2;
  return release.protocol === prefer ? 0 : 1;
};

/**
 * The delay profile Lidarr uses for an artist: the first, in Lidarr's
 * order, sharing a tag with them, else the one for everyone.
 */
export const delayProfileFor = (
  profiles: LidarrDelayProfile[],
  artistTags: number[]
): LidarrDelayProfile | undefined =>
  [...profiles]
    .sort((a, b) => a.order - b.order)
    .find((p) => p.tags.some((tag) => artistTags.includes(tag))) ??
  profiles.find((p) => !p.tags.length);

/** Releases of an album in the order they are opened. */
export const rankReleases = (
  releases: ProwlarrRelease[],
  prefer: LidarrDelayProfile['preferredProtocol'] = 'torrent'
): ProwlarrRelease[] =>
  [...releases].sort(
    (a, b) =>
      releaseTier(a, prefer) - releaseTier(b, prefer) ||
      (b.seeders ?? 0) - (a.seeders ?? 0) ||
      a.size - b.size
  );

/** Results opened for their file lists, best first. */
const MAX_OPEN = 5;
/** Packs of an artist's releases read in one search, when nothing names the album. */
const MAX_CATALOGS = 3;

/** A release as a fetch keeps it. */
type FetchRelease = NonNullable<SongFetch['release']>;

/** A release chosen for songs, with each song's file in it. */
interface ChosenRelease {
  release: ProwlarrRelease;
  files: SongFetchFile[];
  hash: string | null;
}

/**
 * Each wanted song's file in a release, as `find` finds it: each file one
 * song, never two tracks from the same file.
 */
const pickSongs = <T extends { index: number; path: string; size: number }>(
  files: T[],
  wanted: { song: SongRequest; track: LidarrTrack }[],
  find: (rest: T[], track: LidarrTrack) => T | undefined
): SongFetchFile[] => {
  const picked: SongFetchFile[] = [];
  for (const { song, track } of wanted) {
    const file = find(
      files.filter((f) => !picked.some((p) => p.index === f.index)),
      track
    );
    if (file) {
      picked.push({
        index: file.index,
        path: file.path,
        size: file.size,
        recordingMbid: song.recordingMbid,
        trackId: track.id,
      });
    }
  }
  return picked;
};
/**
 * A download that has brought nothing for this long stops holding one of
 * the song download slots, so the next song can start meanwhile; it is
 * still given up only at Backfill's stall time.
 */
const IDLE_SLOT_MS = 15 * 60_000;
/** Releases tried before the songs are given up on. */
const MAX_TRIES = 3;
/** Soulseek sharers tried before Soulseek is passed over for the songs. */
const MAX_SOULSEEK_TRIES = 5;
/** Songs of an album Soulseek is searched for each time, one at a time. */
const MAX_SOULSEEK_SEARCHES = 3;
/** How long a sharer's queue is waited in before another is tried. */
const SOULSEEK_QUEUE_GIVE_UP_MS = 2 * 60 * 60_000;
/** Where slskd puts songs' files, under its downloads folder. */
const SOULSEEK_FOLDER = 'seerr-ai';
/** What `tried` holds for a Soulseek sharer. */
const sharerKey = (username: string) => `soulseek:${username}`;
/** Bigger than any album the songs are worth. */
const MAX_RELEASE_BYTES = 4 * 1024 ** 3;
/** How long the swarm may take to send a magnet's file list. */
const METADATA_GIVE_UP_MS = 30 * 60_000;
/** How long Lidarr may take to import. */
const IMPORT_GIVE_UP_MS = 3 * 60 * 60_000;
/** How long Lidarr may take to know the artist and album. */
const LOOKUP_GIVE_UP_MS = 7 * 24 * 60 * 60_000;
/**
 * How long to wait before looking again for a release with the songs, after
 * each search that found none: indexers come and go, so the songs are
 * given up on only after about two days of finding nothing.
 */
const SEARCH_AGAIN_MS = [1, 3, 6, 12, 24].map((hours) => hours * 60 * 60_000);
/** How soon a search Prowlarr or an indexer couldn't answer is tried again. */
const SEARCH_SOON_MS = 10 * 60_000;
/** What a fetch waiting to look again shows. */
const SEARCHING_AGAIN = 'Nothing found yet; looking again later';
/** How long a fetch may keep stumbling on errors before it gives up. */
const STUMBLE_GIVE_UP_MS = 24 * 60 * 60_000;

/** A fetch's statuses while it is under way. */
export const ACTIVE: SongFetch['status'][] = [
  'queued',
  'searching',
  'downloading',
  'importing',
];

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A failure that is the release's fault: the next release is tried. */
class ReleaseProblem extends Error {}

/** A torrent's stage until only the songs' files are picked and it starts. */
const CHOOSING = 'Choosing the songs’ files';

/**
 * Whether a download counts against the song download slots: not once it
 * has brought nothing for a while (`idleMs`, as its watch last saw), or the
 * swarm hasn't sent its file list for as long, so one nobody shares doesn't
 * hold up the songs behind it.
 */
export const holdsSlot = (
  fetch: Pick<SongFetch, 'stage' | 'startedAt'>,
  idleMs: number,
  now = Date.now()
): boolean =>
  fetch.stage === CHOOSING
    ? !fetch.startedAt || now - fetch.startedAt.getTime() < IDLE_SLOT_MS
    : idleMs < IDLE_SLOT_MS;

/**
 * Songs in a request another of its songs failed in: the request shows as
 * failed, but its other songs carry on.
 */
const UNDER_WAY = [MediaRequestStatus.APPROVED, MediaRequestStatus.FAILED];

const clientById = (id: number | null): DownloadClientSettings => {
  const client = getSettings().downloadClients.find((c) => c.id === id);
  if (!client) throw new Error('The download client was removed from Seerr.');
  return client;
};

/** A song's track in Lidarr's album: its recording, else its title. */
export const trackOf = (
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

/**
 * Fetches in the order a tick moves them along: what is quick first
 * (setting an album up in Lidarr, starting a chosen release, following a
 * download or an import), then searches, which take a minute or more each
 * and all come due at once after an update. Oldest first within each.
 */
export const quickestFirst = <
  T extends Pick<SongFetch, 'id' | 'status' | 'release' | 'files'>,
>(
  fetches: T[]
): T[] => {
  const searches = (fetch: T) =>
    fetch.status === 'searching' && !(fetch.release && fetch.files.length);
  return [...fetches].sort(
    (a, b) => Number(searches(a)) - Number(searches(b)) || a.id - b.id
  );
};

class SongFetcher {
  private ticking = false;

  /** Moving songs along right now, for the job's status. */
  public isRunning(): boolean {
    return this.ticking;
  }

  /** Every minute: starts fetches for new songs and moves each along. */
  public async tick(): Promise<void> {
    if (this.ticking || !musicReady() || songFetchProblem()) return;
    this.ticking = true;
    try {
      // Songs whose single Lidarr found nothing for join those taken from
      // albums, before those are planned.
      await singleFallback.run().catch((e) =>
        logger.warn('Could not check singles Lidarr is looking for', {
          label: LABEL,
          errorMessage: message(e),
        })
      );
      await this.plan();
      await this.linkFinished();
      await this.correctFinished();
      const fetches = await getRepository(SongFetch).find({
        where: { status: In(ACTIVE) },
        order: { id: 'ASC' },
      });
      for (const fetch of quickestFirst(fetches)) {
        try {
          await this.advance(fetch);
          this.troubleSince.delete(fetch.id);
        } catch (e) {
          await this.stumbled(fetch, e);
        }
      }
      this.showDownloads(fetches);
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
        request: { status: In(UNDER_WAY) },
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
      // One fetch at a time for an album: a second would download it again,
      // or take the first's download for a release that failed. One that
      // hasn't chosen a release yet takes the new songs; one downloading
      // finishes first.
      const under = active.find(
        (fetch) => fetch.albumMbid === albumMbid && fetch.status !== 'done'
      );
      if (under) {
        if (
          under.status === 'queued' ||
          (under.status === 'searching' && !under.release)
        ) {
          under.recordings = [
            ...new Set([
              ...under.recordings,
              ...list.map((song) => song.recordingMbid),
            ]),
          ];
          await getRepository(SongFetch).update(under.id, {
            recordings: under.recordings,
          });
        }
        continue;
      }
      const { request } = list[0];
      const media = request.media;
      const server = this.lidarrOf(request.serverId);
      if (!server || !media?.foreignId) {
        await this.failSongs(
          list,
          server
            ? 'The song’s artist is unknown.'
            : 'No Lidarr server is set up for music.'
        );
        continue;
      }
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

  /**
   * The songs it is for that are still asked for, approved: each by its own
   * status, so one song failing doesn't stop the others in its request.
   */
  private async songsOf(fetch: SongFetch): Promise<SongRequest[]> {
    if (!fetch.recordings.length) return [];
    return getRepository(SongRequest).find({
      where: {
        recordingMbid: In(fetch.recordings),
        sourceAlbumMbid: fetch.albumMbid,
        status: MediaRequestStatus.APPROVED,
        request: { status: In(UNDER_WAY) },
      },
      relations: { request: { media: true } },
    });
  }

  private async advance(fetch: SongFetch): Promise<void> {
    const songs = await this.songsOf(fetch);
    if (!songs.length) {
      await this.removeDownload(fetch).catch(() => undefined);
      // The scans can finish its songs before it ends (while Lidarr imports).
      const finished = fetch.recordings.length
        ? await getRepository(SongRequest).count({
            where: {
              recordingMbid: In(fetch.recordings),
              sourceAlbumMbid: fetch.albumMbid,
              status: MediaRequestStatus.COMPLETED,
            },
          })
        : 0;
      await this.end(
        fetch,
        finished ? 'done' : 'failed',
        finished
          ? null
          : 'Its songs are no longer asked for: declined, removed or failed.'
      );
      return;
    }
    if (
      fetch.status === 'queued' &&
      Date.now() - fetch.createdAt.getTime() > LOOKUP_GIVE_UP_MS
    ) {
      await this.failSongs(
        songs,
        `Lidarr couldn’t look up ${fetch.albumTitle} for a week. Retry later.`,
        fetch
      );
      await this.end(fetch, 'failed', 'Lidarr could not look up the album.');
      return;
    }
    switch (fetch.status) {
      case 'queued':
        await this.prepare(fetch, songs);
        return;
      case 'searching':
        // Chosen already, and waiting for a download slot or the indexer.
        if (fetch.release && fetch.files.length) {
          await this.start(fetch);
          return;
        }
        // Found nothing last time: waits its turn to look again.
        if (fetch.searchAgainAt && fetch.searchAgainAt.getTime() > Date.now()) {
          return;
        }
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
    // Not on the edition Lidarr has (another can't be imported into while
    // it has files of this one): taken from the artist's next album with
    // it, else its single, if there is one.
    const unknown = songs.filter((song) => !trackOf(tracks, song));
    if (unknown.length) {
      await this.toNextAlbum(
        fetch,
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
   * was fixed, such albums were taken as wholly here. Lidarr is asked once
   * for each album.
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
      // Asked once: the counts Lidarr gave are kept, and the music scans
      // keep the album's status from then on.
      if (
        row?.status !== MediaStatus.AVAILABLE ||
        (row.trackCount != null && row.trackFileCount != null)
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
    // Only indexers with music that aren't resting: a search waits on every
    // indexer it asks. Without an answer, all of them.
    const indexerIds = await prowlarr.musicIndexerIds().catch((e) => {
      logger.debug('Could not read Prowlarr’s indexers', {
        label: LABEL,
        errorMessage: message(e),
      });
      return undefined;
    });
    if (indexerIds && !indexerIds.length) {
      throw new Error('No indexer in Prowlarr with music is answering.');
    }
    const found = new Map<string, ProwlarrRelease>();
    let searchError: unknown;
    for (const term of [
      `${fetch.artistName} ${fetch.albumTitle}`,
      fetch.albumTitle,
    ]) {
      try {
        for (const release of await indexerLimits.guard(
          PROWLARR,
          'search',
          () =>
            prowlarr.search(term, { categories: AUDIO_CATEGORIES, indexerIds })
        )) {
          found.set(release.infoHash?.toLowerCase() || release.guid, release);
        }
      } catch (e) {
        if (e instanceof IndexerLimitReached) {
          fetch.stage = e.message;
          await getRepository(SongFetch).save(fetch);
          return;
        }
        // Prowlarr not answering in time is no answer: the other search
        // may still find it.
        searchError = e;
        continue;
      }
      if (found.size >= MAX_OPEN) break;
    }

    // As Lidarr would choose for the artist: the protocol it prefers, and
    // none it is told not to use. Without an answer, torrents first.
    const profile = await Promise.all([
      lidarr.getDelayProfiles(),
      fetch.lidarrArtistId
        ? lidarr.getArtistByMbid(fetch.artistMbid)
        : Promise.resolve(undefined),
    ])
      .then(([profiles, artist]) =>
        delayProfileFor(profiles, artist?.tags ?? [])
      )
      .catch((e) => {
        logger.debug('Could not read Lidarr’s delay profiles', {
          label: LABEL,
          errorMessage: message(e),
        });
        return undefined;
      });
    const prefer = profile?.preferredProtocol ?? 'torrent';
    const usable = rankReleases(
      [...found.values()].filter(
        (release) =>
          !!clientFor(release.protocol) &&
          (release.protocol === 'torrent'
            ? profile?.enableTorrent !== false
            : profile?.enableUsenet !== false) &&
          release.size <= MAX_RELEASE_BYTES &&
          !fetch.tried.includes(release.guid) &&
          !fetch.tried.includes(`hash:${release.infoHash?.toLowerCase()}`) &&
          namesAlbum(release.title, fetch.albumTitle, fetch.artistName)
      ),
      prefer
    ).slice(0, MAX_OPEN);

    // Nothing usable while a search failed: it may have been there. Tried
    // again soon, not counted as a search that found nothing.
    if (!usable.length && searchError) {
      await this.searchSoon(
        fetch,
        `Prowlarr didn’t answer: ${message(searchError)}`
      );
      return;
    }

    let best:
      | {
          release: ProwlarrRelease;
          files: SongFetchFile[];
          hash: string | null;
        }
      | undefined;
    // A Usenet post whose files are packed or renamed: they are only known
    // once it is downloaded, when each song is found by its name.
    let packedRelease: ProwlarrRelease | undefined;
    // An indexer waiting out its download limit: its releases are passed
    // over this time, and the others opened.
    let limited: IndexerLimitReached | undefined;
    // The releases whose files were read, for the log when none has them.
    const opened: string[] = [];
    for (const release of usable) {
      // Torrents nobody seems to share, only when nothing better was found.
      if (releaseTier(release, prefer) === 2 && (best || packedRelease)) break;
      try {
        const { files, infoHash, packed } = await backfill.filesOf(release);
        if (packed) {
          if (release.protocol === 'usenet') packedRelease ??= release;
          continue;
        }
        opened.push(release.title);
        const picked = pickSongs(files, wanted, (rest, track) =>
          fileForTrack(rest, track.title, fetch.artistName)
        );
        if (picked.length > (best?.files.length ?? 0)) {
          best = { release, files: picked, hash: infoHash };
        }
        if (picked.length === wanted.length) break;
      } catch (e) {
        if (e instanceof IndexerLimitReached) {
          limited ??= e;
          continue;
        }
        logger.debug('Could not read a release of an album', {
          label: LABEL,
          release: release.title,
          errorMessage: message(e),
        });
      }
    }

    // Nothing named for the album has the songs: a Soulseek sharer may,
    // file by file.
    let shared: { release: FetchRelease; files: SongFetchFile[] } | undefined;
    if (!best && !packedRelease && !limited) {
      shared = await this.fromSoulseek(fetch, wanted);
    }

    // Nor a sharer: a pack of the artist's own releases may (their
    // discography, a collection), as smaller artists are mostly shared.
    // Only the songs' files are taken from it.
    if (!best && !shared && !packedRelease && !limited) {
      const catalog = await this.fromCatalog(
        fetch,
        wanted,
        prowlarr,
        indexerIds,
        profile,
        prefer,
        opened
      );
      if (catalog === 'limited') {
        await this.searchSoon(fetch, 'An indexer is waiting out its limit');
        return;
      }
      best = catalog;
    }

    if (!best && !shared && packedRelease) {
      best = {
        release: packedRelease,
        files: wanted.map(({ song, track }, index) => ({
          index,
          path: '',
          size: 0,
          recordingMbid: song.recordingMbid,
          trackId: track.id,
        })),
        hash: null,
      };
    }

    const needed = wanted.map((w) => w.song);
    // What a resting indexer has may be it: looked at again soon, not
    // counted as a search that found nothing.
    if (!best && !shared && limited) {
      await this.searchSoon(fetch, limited.message);
      return;
    }
    if (!best && !shared && opened.length) {
      logger.info('No release found has the songs by name', {
        label: LABEL,
        fetchId: fetch.id,
        album: fetch.albumTitle,
        songs: wanted.map((w) => w.track.title),
        releases: opened.slice(0, 5),
      });
    }
    if (!best && !shared) {
      const wait = SEARCH_AGAIN_MS[fetch.searches ?? 0];
      if (wait !== undefined) {
        fetch.searches = (fetch.searches ?? 0) + 1;
        fetch.searchAgainAt = new Date(Date.now() + wait);
        fetch.stage = SEARCHING_AGAIN;
        await getRepository(SongFetch).save(fetch);
        logger.info('No release with the songs yet; looking again later', {
          label: LABEL,
          fetchId: fetch.id,
          album: fetch.albumTitle,
          searches: fetch.searches,
          searchAgainAt: fetch.searchAgainAt.toISOString(),
        });
        return;
      }
      await this.failSongs(
        needed,
        `No release of ${fetch.albumTitle} with “${needed[0].title}” was found.`,
        fetch
      );
      await this.end(fetch, 'failed', 'No release with the songs was found.');
      return;
    }
    const files = shared?.files ?? best!.files;
    // Not in the release chosen for the others: searched for again on their
    // own, on the usual schedule, once this download is done.
    const missed = new Set(
      needed
        .filter(
          (song) =>
            !files.some((file) => file.recordingMbid === song.recordingMbid)
        )
        .map((song) => song.recordingMbid)
    );
    if (missed.size) {
      fetch.recordings = fetch.recordings.filter((id) => !missed.has(id));
    }

    fetch.searchAgainAt = null;
    if (shared) {
      fetch.release = shared.release;
    } else {
      const { release, hash } = best!;
      fetch.release = {
        guid: release.guid,
        title: release.title,
        indexer: release.indexer,
        indexerId: release.indexerId,
        protocol: release.protocol,
        size: release.size,
        downloadUrl: release.downloadUrl,
        magnetUrl: release.magnetUrl,
        infoHash: hash ?? release.infoHash?.toLowerCase(),
      };
    }
    fetch.files = files;
    await this.start(fetch);
  }

  /**
   * The songs from a Soulseek sharer, when Soulseek is set up: each song
   * searched for by artist and title (the first few of an album's), and of
   * the sharers with a file named as one, the best (see soulseekSongs). A
   * sharer tried already is passed over, and Soulseek altogether after a
   * few. slskd not answering is no reason to stop: the rest is looked at.
   */
  private async fromSoulseek(
    fetch: SongFetch,
    wanted: { song: SongRequest; track: LidarrTrack }[]
  ): Promise<{ release: FetchRelease; files: SongFetchFile[] } | undefined> {
    const soulseek = soulseekOf(getSettings().music);
    if (!soulseek) return undefined;
    const tried = new Set(
      fetch.tried
        .filter((key) => key.startsWith(sharerKey('')))
        .map((key) => key.slice(sharerKey('').length))
    );
    if (tried.size >= MAX_SOULSEEK_TRIES) return undefined;
    const api = new SlskdAPI(soulseek);
    const answers: SlskdResponse[][] = [];
    for (const { track } of wanted.slice(0, MAX_SOULSEEK_SEARCHES)) {
      try {
        answers.push(
          await api.search(soulseekQuery(fetch.artistName, track.title))
        );
      } catch (e) {
        logger.debug('Could not search Soulseek', {
          label: LABEL,
          fetchId: fetch.id,
          errorMessage: message(e),
        });
        break;
      }
    }
    if (!answers.length) return undefined;
    const choice = chooseSharer(
      mergeResponses(answers),
      wanted,
      fetch.albumTitle,
      fetch.artistName,
      tried
    );
    if (!choice) {
      logger.info('No Soulseek sharer has the songs by name', {
        label: LABEL,
        fetchId: fetch.id,
        album: fetch.albumTitle,
        songs: wanted.map((w) => w.track.title),
      });
      return undefined;
    }
    logger.info('Taking songs from a Soulseek sharer', {
      label: LABEL,
      fetchId: fetch.id,
      album: fetch.albumTitle,
      folder: choice.folder,
      songs: choice.files.length,
    });
    const folders = choice.folder.replace(/\\/g, '/').split('/');
    return {
      release: {
        guid: sharerKey(choice.username),
        title: folders.slice(-2).join(' / ') || choice.folder,
        indexer: 'Soulseek',
        indexerId: 0,
        protocol: 'soulseek',
        size: choice.files.reduce((n, f) => n + f.size, 0),
        username: choice.username,
      },
      files: choice.files,
    };
  }

  /**
   * Songs from the artist's other releases, found by searching for the
   * artist's name, as Lidarr's profile allows: first a pack of their own
   * releases (a discography, a collection); else, with Backfill's second
   * opinion on, the releases the model names as holding them (the album a
   * single is on). Each release's files are read and the songs found in it
   * by name, the album's folder first. Packed Usenet posts are passed over:
   * the whole release would be downloaded.
   */
  private async fromCatalog(
    fetch: SongFetch,
    wanted: { song: SongRequest; track: LidarrTrack }[],
    prowlarr: ProwlarrAPI,
    indexerIds: number[] | undefined,
    profile: LidarrDelayProfile | undefined,
    prefer: LidarrDelayProfile['preferredProtocol'],
    opened: string[]
  ): Promise<ChosenRelease | 'limited' | undefined> {
    let releases: ProwlarrRelease[];
    try {
      releases = await indexerLimits.guard(PROWLARR, 'search', () =>
        prowlarr.search(fetch.artistName, {
          categories: AUDIO_CATEGORIES,
          indexerIds,
        })
      );
    } catch (e) {
      if (e instanceof IndexerLimitReached) return 'limited';
      logger.debug('Could not search for the artist’s releases', {
        label: LABEL,
        fetchId: fetch.id,
        errorMessage: message(e),
      });
      return undefined;
    }
    const allowed = rankReleases(
      releases.filter(
        (release) =>
          !!clientFor(release.protocol) &&
          (release.protocol === 'torrent'
            ? profile?.enableTorrent !== false
            : profile?.enableUsenet !== false) &&
          !fetch.tried.includes(release.guid) &&
          !fetch.tried.includes(`hash:${release.infoHash?.toLowerCase()}`) &&
          namesArtist(release.title, fetch.artistName)
      ),
      prefer
    );
    const packs = allowed.filter((release) =>
      namesCatalog(release.title, fetch.artistName)
    );
    const fromPack = await this.readReleases(
      fetch,
      wanted,
      packs.slice(0, MAX_CATALOGS),
      prefer,
      opened
    );
    if (fromPack.best) {
      logger.info('Taking songs from a pack of the artist’s releases', {
        label: LABEL,
        fetchId: fetch.id,
        album: fetch.albumTitle,
        release: fromPack.best.release.title,
        songs: fromPack.best.files.length,
      });
      return fromPack.best;
    }

    const ask = aiSongSources(await owner());
    const others = allowed.filter(
      (release) =>
        !packs.includes(release) &&
        !opened.includes(release.title) &&
        release.size <= MAX_RELEASE_BYTES &&
        // Its files may be named just as the songs (a live album's are).
        !namesOtherVersion(
          release.title,
          fetch.albumTitle,
          fetch.artistName,
          ...wanted.map((w) => w.track.title)
        )
    );
    if (!ask || !others.length) {
      return fromPack.limited ? 'limited' : undefined;
    }
    let named: SongSourceAnswer;
    try {
      named = await ask({
        artist: fetch.artistName,
        songs: wanted.map((w) => w.track.title),
        album: fetch.albumTitle,
        releases: others,
      });
    } catch (e) {
      logger.debug(
        'Backfill’s second opinion could not say where the songs are',
        {
          label: LABEL,
          fetchId: fetch.id,
          errorMessage: message(e),
        }
      );
      return fromPack.limited ? 'limited' : undefined;
    }
    const fromNamed = await this.readReleases(
      fetch,
      wanted,
      named.releases,
      prefer,
      opened
    );
    if (fromNamed.best) {
      logger.info(
        'Taking songs from a release Backfill’s second opinion named',
        {
          label: LABEL,
          fetchId: fetch.id,
          album: fetch.albumTitle,
          release: fromNamed.best.release.title,
          why: named.why,
          songs: fromNamed.best.files.length,
        }
      );
      return fromNamed.best;
    }
    return fromPack.limited || fromNamed.limited ? 'limited' : undefined;
  }

  /**
   * The release of these with the most of the songs, each found in it by
   * name (the album's folder first, never another version's), the best
   * shared first; a torrent nobody shares only when nothing else has them.
   */
  private async readReleases(
    fetch: SongFetch,
    wanted: { song: SongRequest; track: LidarrTrack }[],
    releases: ProwlarrRelease[],
    prefer: LidarrDelayProfile['preferredProtocol'],
    opened: string[]
  ): Promise<{ best?: ChosenRelease; limited: boolean }> {
    let best: ChosenRelease | undefined;
    let limited = false;
    for (const release of releases) {
      if (releaseTier(release, prefer) === 2 && best) break;
      try {
        const { files, infoHash, packed } = await backfill.filesOf(release);
        if (packed) continue;
        opened.push(release.title);
        const picked = pickSongs(files, wanted, (rest, track) =>
          fileInCatalog(rest, track.title, fetch.albumTitle, fetch.artistName)
        );
        if (picked.length > (best?.files.length ?? 0)) {
          best = { release, files: picked, hash: infoHash };
        }
        if (picked.length === wanted.length) break;
      } catch (e) {
        if (e instanceof IndexerLimitReached) {
          limited = true;
          continue;
        }
        logger.debug('Could not read a release of the artist’s', {
          label: LABEL,
          release: release.title,
          errorMessage: message(e),
        });
      }
    }
    return { best, limited };
  }

  /**
   * Songs this album can't bring moved to the artist's next album with the
   * same recording, in the order albums are chosen in (so never back to
   * one tried), to be taken from it; failed when none is left.
   */
  private async toNextAlbum(
    fetch: SongFetch,
    songs: SongRequest[],
    reason: string
  ): Promise<void> {
    const failing: SongRequest[] = [];
    for (const song of songs) {
      const recording = await musicBrainz()
        .getRecording(song.recordingMbid, 'background')
        .catch(() => null);
      const version = recording ? toVersion(recording) : null;
      const albums = version ? albumsFor(version) : [];
      const single = version ? singleFor(version) : null;
      const at = albums.findIndex((album) => album.mbId === fetch.albumMbid);
      // After the last album with it, its own single; after that, nothing.
      const next =
        single?.mbId === fetch.albumMbid
          ? undefined
          : (albums[at + 1] ?? (at >= 0 ? single : undefined));
      if (!next || next.mbId === fetch.albumMbid) {
        failing.push(song);
        continue;
      }
      await getRepository(SongRequest).update(song.id, {
        sourceAlbumMbid: next.mbId,
        sourceAlbumTitle: next.title,
      });
      fetch.recordings = fetch.recordings.filter(
        (id) => id !== song.recordingMbid
      );
      logger.info('Taking a song from another album with it', {
        label: LABEL,
        song: song.title,
        from: fetch.albumTitle,
        album: next.title,
      });
    }
    if (failing.length) await this.failSongs(failing, reason, fetch);
    await getRepository(SongFetch).update(fetch.id, {
      recordings: fetch.recordings,
    });
  }

  /**
   * Searched again in a few minutes, the search not counted: Prowlarr or an
   * indexer couldn't answer, which says nothing of whether it's there.
   */
  private async searchSoon(fetch: SongFetch, why: string): Promise<void> {
    fetch.searchAgainAt = new Date(Date.now() + SEARCH_SOON_MS);
    fetch.stage = `${SEARCHING_SOON}: ${why}`.slice(0, 250);
    await getRepository(SongFetch).save(fetch);
  }

  /** Adds the release to Backfill's download client. */
  private async start(fetch: SongFetch): Promise<void> {
    const release = fetch.release!;
    // Soulseek's files come through slskd, not a download client.
    const client =
      release.protocol === 'soulseek' ? undefined : clientFor(release.protocol);
    if (release.protocol !== 'soulseek' && !client) {
      throw new Error(
        `No ${release.protocol === 'torrent' ? 'torrent' : 'Usenet'} client is chosen in Settings → Backfill.`
      );
    }
    const downloading = await getRepository(SongFetch).find({
      select: { id: true, stage: true, startedAt: true },
      where: { id: Not(fetch.id), status: 'downloading' },
    });
    const running = downloading.filter((other) =>
      holdsSlot(other, this.watch.idleFor(other.id))
    );
    if (running.length >= getSettings().backfill.maxActiveJobs) {
      fetch.stage = 'Waiting for another song download to finish';
      await getRepository(SongFetch).save(fetch);
      return;
    }
    if (release.protocol === 'soulseek' || !client) {
      await this.startSoulseek(fetch);
      return;
    }
    const protocol = release.protocol;
    const category = getSettings().backfill.category;
    let fetched: FetchedRelease;
    try {
      fetched = await indexerLimits.guard(
        { id: release.indexerId, name: release.indexer },
        'download',
        () =>
          new ProwlarrAPI(getSettings().backfill.prowlarr).fetchRelease({
            ...release,
            protocol,
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
      fetch.stage = CHOOSING;
    } else {
      if (fetched.kind !== 'nzb') throw new ReleaseProblem('Expected an NZB.');
      // Only the songs' files, when the post names them: the rest of the
      // album isn't downloaded, nor left behind (the client never deletes
      // what it finished).
      const chosen = new Set(fetch.files.map((file) => file.index));
      const only = fetch.files.every((file) => file.path)
        ? nzbWith(fetched.data, (file) => chosen.has(file.index))
        : undefined;
      fetch.downloadId = await usenetClientFor(client).addNzb(
        only ? Buffer.from(only, 'utf8') : fetched.data,
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

  /**
   * Asks the sharer for the songs' files, through slskd, into a folder of
   * their own under slskd's downloads. A sharer offline, or turning them
   * down, is the release's fault: the next is tried.
   */
  private async startSoulseek(fetch: SongFetch): Promise<void> {
    const release = fetch.release!;
    const soulseek = soulseekOf(getSettings().music);
    if (!soulseek || !release.username) {
      throw new ReleaseProblem(
        'Soulseek is no longer set up in Settings → Services.'
      );
    }
    const folder = `${SOULSEEK_FOLDER}/song-${fetch.id}-${Date.now().toString(36)}`;
    try {
      fetch.downloadId = await new SlskdAPI(soulseek).download(
        release.username,
        fetch.files.map((file) => ({ filename: file.path, size: file.size })),
        folder
      );
    } catch (e) {
      if (e instanceof SlskdRefused) throw new ReleaseProblem(e.message);
      throw e;
    }
    fetch.release = { ...release, folder };
    fetch.clientId = null;
    fetch.status = 'downloading';
    fetch.stage = 'Asked for on Soulseek';
    fetch.startedAt = new Date();
    await getRepository(SongFetch).save(fetch);
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
    if (fetch.release?.protocol === 'soulseek') {
      await this.followSoulseek(fetch, songs);
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
      if (fetch.stage === CHOOSING) {
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
        this.sizes.set(fetch.id, { size: all, left: all - have });
        await this.stalled(fetch, {
          have,
          left: all - have,
          held: torrentStage(torrent, torrents.product).held,
          incomplete: swarmLacks(torrent, chosen),
        });
        return;
      }
      // Lidarr copies what it is given: never a file named out of the
      // torrent's folder.
      if (chosen.some((f) => f.name.split(/[\\/]/).includes('..'))) {
        throw new ReleaseProblem(
          'The torrent names files outside its own folder.'
        );
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
        const size = fetch.release?.size || 1;
        const left = size * (1 - Math.min(100, job.percentage) / 100);
        this.sizes.set(fetch.id, { size, left });
        // Waiting its turn in the client's queue is no stall; paused (by
        // its duplicate check, or for lack of space) is, and gives up its
        // slot, then its release, as a stalled torrent does.
        await this.stalled(fetch, {
          have: size - left,
          left,
          held: /^(queued|propagating|grabbing|fetching)$/i.test(job.status),
          incomplete: false,
        });
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
      // Lidarr reads the finished folder; each song's file by the name it
      // had in the NZB, or, when the post was packed, renamed or its names
      // scrambled, by the song's own name.
      const seen = await lidarr.getManualImport(
        lidarrPath(job.storage),
        fetch.lidarrArtistId!
      );
      const unpacked = seen.map((item, index) => ({
        index,
        path: item.path,
        // Lidarr not saying is no reason to pass a file over.
        size: item.size ?? Number.MAX_SAFE_INTEGER,
      }));
      const baseName = (path: string) =>
        path.replace(/\\/g, '/').split('/').pop();
      let tracks: LidarrTrack[] | undefined;
      paths = new Map();
      for (const file of fetch.files) {
        const name = baseName(file.path);
        let match = name
          ? seen.find((s) => baseName(s.path) === name)?.path
          : undefined;
        if (!match) {
          tracks ??= await this.tracksOf(lidarr, fetch);
          const taken = new Set(paths.values());
          match = fileForTrack(
            unpacked.filter((u) => !taken.has(u.path)),
            tracks.find((t) => t.id === file.trackId)?.title ?? '',
            fetch.artistName
          )?.path;
        }
        if (match) paths.set(file.index, match);
      }
    }
    await this.importFiles(fetch, songs, paths);
  }

  /**
   * Follows a Soulseek download. Waiting in the sharer's queue is no stall,
   * up to a couple of hours; then, or once a file fails, the next sharer is
   * tried. Once every file is in, Lidarr reads the folder and imports them.
   */
  private async followSoulseek(
    fetch: SongFetch,
    songs: SongRequest[]
  ): Promise<void> {
    const release = fetch.release!;
    const soulseek = soulseekOf(getSettings().music);
    if (!soulseek) {
      throw new ReleaseProblem(
        'Soulseek is no longer set up in Settings → Services.'
      );
    }
    const batch = await new SlskdAPI(soulseek).getBatch(fetch.downloadId!);
    const transfers = batch?.transfers ?? [];
    if (!transfers.length) {
      throw new ReleaseProblem('slskd no longer has the download.');
    }
    const failed = transfers.find(
      (t) => transferIs(t, 'Completed') && !transferIs(t, 'Succeeded')
    );
    if (failed) {
      throw new ReleaseProblem(
        `Soulseek: ${failed.state.replace(/^Completed,\s*/, '')}${
          failed.exception ? ` (${failed.exception})` : ''
        }`
      );
    }
    if (!transfers.every((t) => transferIs(t, 'Succeeded'))) {
      const all = transfers.reduce((n, t) => n + t.size, 0) || 1;
      const have = transfers.reduce(
        (n, t) => n + Math.min(t.bytesTransferred ?? 0, t.size),
        0
      );
      const queued =
        have === 0 && transfers.some((t) => transferIs(t, 'Queued'));
      if (
        queued &&
        fetch.startedAt &&
        Date.now() - fetch.startedAt.getTime() > SOULSEEK_QUEUE_GIVE_UP_MS
      ) {
        throw new ReleaseProblem(
          'Waited over two hours in the sharer’s queue on Soulseek.'
        );
      }
      const place = transfers.find((t) => t.placeInQueue)?.placeInQueue;
      fetch.stage = queued
        ? `Waiting in a Soulseek queue${place ? `, place ${place}` : ''}`
        : `Downloading from Soulseek, ${Math.floor((have / all) * 100)}%`;
      this.sizes.set(fetch.id, { size: all, left: all - have });
      await this.stalled(fetch, {
        have,
        left: all - have,
        held: queued,
        incomplete: false,
      });
      return;
    }
    // In: Lidarr reads the folder, each song's file by its name, else by
    // the song's own name (slskd may have made the name safe for disk).
    const lidarr = this.lidarr(fetch);
    const root = soulseek.downloadsPath.replace(/[\\/]+$/, '');
    const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
    const folder = `${root}${sep}${(release.folder ?? '').replace(/\//g, sep)}`;
    const seen = await lidarr.getManualImport(folder, fetch.lidarrArtistId!);
    const listed = seen.map((item, index) => ({
      index,
      path: item.path,
      size: item.size ?? Number.MAX_SAFE_INTEGER,
    }));
    const baseName = (path: string) =>
      path.replace(/\\/g, '/').split('/').pop() ?? '';
    let tracks: LidarrTrack[] | undefined;
    const paths = new Map<number, string>();
    for (const file of fetch.files) {
      const taken = new Set(paths.values());
      const rest = listed.filter((l) => !taken.has(l.path));
      let match = rest.find(
        (l) => baseName(l.path) === baseName(file.path)
      )?.path;
      if (!match) {
        tracks ??= await this.tracksOf(lidarr, fetch);
        match = fileForTrack(
          rest,
          tracks.find((t) => t.id === file.trackId)?.title ?? '',
          fetch.artistName
        )?.path;
      }
      if (match) paths.set(file.index, match);
    }
    await this.importFiles(fetch, songs, paths);
  }

  /**
   * A torrent that stalls, can't finish or crawls, by Backfill's limits, is
   * given up, and the next release tried.
   */
  private async stalled(
    fetch: SongFetch,
    reading: TorrentReading
  ): Promise<void> {
    const { stallHours, slowHours } = getSettings().backfill;
    const giveUp = this.watch.check(fetch.id, reading, {
      stallHours,
      slowHours,
    });
    if (giveUp) throw new ReleaseProblem(giveUp);
    await getRepository(SongFetch).save(fetch);
  }

  private watch = new TorrentWatch();

  /** Each download's size and what is left of it, as last read. */
  private sizes = new Map<number, { size: number; left: number }>();

  /**
   * What is downloading or importing, for the downloading pills on the
   * album, its songs and their requests, as Lidarr's own downloads have.
   */
  private showDownloads(fetches: SongFetch[]): void {
    const shown = fetches.filter(
      (fetch) =>
        (fetch.status === 'downloading' || fetch.status === 'importing') &&
        fetch.lidarrArtistId != null &&
        fetch.lidarrAlbumId != null
    );
    for (const id of this.sizes.keys()) {
      if (!shown.some((fetch) => fetch.id === id)) this.sizes.delete(id);
    }
    downloadTracker.setSongDownloads(
      shown.map((fetch) => {
        const importing = fetch.status === 'importing';
        const known = this.sizes.get(fetch.id);
        const size = known?.size ?? fetch.release?.size ?? 0;
        return {
          serverId: fetch.lidarrId,
          item: {
            mediaType: MediaType.MUSIC,
            externalId: fetch.lidarrArtistId!,
            size,
            sizeLeft: importing ? 0 : (known?.left ?? size),
            status: fetch.stage ?? '',
            stage: importing ? 'importing' : 'downloading',
            timeLeft: '',
            title: fetch.release?.title ?? fetch.albumTitle,
            downloadId: fetch.downloadId ?? `song-fetch-${fetch.id}`,
            album: {
              id: fetch.lidarrAlbumId!,
              title: fetch.albumTitle,
              foreignAlbumId: fetch.albumMbid,
            },
            songs: fetch.recordings,
          },
        };
      })
    );
  }

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
    // A download with none of the songs in it is the release's fault: the
    // next release is tried.
    if (!ready.length) {
      throw new ReleaseProblem(
        'None of the songs were in the finished download.'
      );
    }
    // Of those it was downloading.
    const lost = songs.filter(
      (song) =>
        fetch.files.some((file) => file.recordingMbid === song.recordingMbid) &&
        !ready.some((file) => file.recordingMbid === song.recordingMbid)
    );
    if (lost.length) {
      await this.failSongs(
        lost,
        `“${lost[0].title}” was not in the finished download.`,
        fetch
      );
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
    // A torrent's files stay for it to seed; a Usenet download's song is
    // moved out, leaving nothing behind.
    fetch.commandId = await lidarr.manualImport(
      fetch.release?.protocol === 'torrent' ? 'copy' : 'move',
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
      // Lidarr not answering says nothing of the import: asked again next
      // time, as one still running is, until it's given up on. A command
      // Lidarr no longer knows (it restarted) is over.
      const command = await lidarr
        .getCommand(fetch.commandId)
        .catch((e: Error) =>
          isAxiosError(e.cause) && e.cause.response?.status === 404
            ? null
            : undefined
        );
      const over =
        command === null ||
        (!!command &&
          ['completed', 'failed', 'aborted', 'cancelled', 'orphaned'].includes(
            command.status
          ));
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
        `Lidarr did not import “${refused[0].title}” from ${fetch.albumTitle}.`,
        fetch
      );
    }
    // Only the songs were wanted, and Lidarr copies them: the download goes,
    // whatever landed.
    await this.removeDownload(fetch).catch((e) =>
      logger.warn('Could not remove a finished song download', {
        label: LABEL,
        fetchId: fetch.id,
        errorMessage: message(e),
      })
    );
    if (landed.length) {
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

  /**
   * Marks songs failed, and each request they are in, with why. Taken off
   * the fetch too (saved when it next is), so a retry fetches them again.
   */
  private async failSongs(
    songs: SongRequest[],
    reason: string,
    fetch?: SongFetch
  ): Promise<void> {
    if (!songs.length) return;
    if (fetch) {
      const failed = new Set(songs.map((song) => song.recordingMbid));
      fetch.recordings = fetch.recordings.filter((id) => !failed.has(id));
    }
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
      // The next release's progress starts afresh.
      this.watch.forget(fetch.id);
      this.troubleSince.delete(fetch.id);
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
      // Soulseek's sharers are counted apart (fromSoulseek).
      if (
        fetch.tried.filter(
          (key) => !key.startsWith('hash:') && !key.startsWith(sharerKey(''))
        ).length >= MAX_TRIES
      ) {
        const songs = await this.songsOf(fetch);
        await this.failSongs(
          songs,
          `No release of ${fetch.albumTitle} could be downloaded: ${message(e)}`,
          fetch
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
    // Given up after a day of nothing but errors, counted from the first.
    const since = this.troubleSince.get(fetch.id) ?? Date.now();
    this.troubleSince.set(fetch.id, since);
    if (Date.now() - since > STUMBLE_GIVE_UP_MS) {
      const songs = await this.songsOf(fetch);
      await this.failSongs(songs, message(e), fetch);
      await this.removeDownload(fetch).catch(() => undefined);
      await this.end(fetch, 'failed', message(e));
      return;
    }
    // A torrent still to have its files picked keeps that stage, which
    // picks them on the next try.
    if (fetch.stage !== CHOOSING) {
      fetch.stage = `Trying again: ${message(e)}`.slice(0, 250);
    }
    await getRepository(SongFetch).save(fetch);
  }

  /** When each fetch began failing for reasons other than its release. */
  private troubleSince = new Map<number, number>();

  private async removeDownload(fetch: SongFetch): Promise<void> {
    if (fetch.release?.protocol === 'soulseek') {
      const soulseek = soulseekOf(getSettings().music);
      if (!fetch.downloadId || !soulseek) return;
      // What Lidarr didn't move goes with the folder.
      const slskd = new SlskdAPI(soulseek);
      const batch = await slskd.getBatch(fetch.downloadId);
      for (const transfer of batch?.transfers ?? []) {
        await slskd.removeTransfer(transfer.username, transfer.id);
      }
      if (fetch.release.folder) {
        await slskd.removeDownloadFolder(fetch.release.folder);
      }
      return;
    }
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
    this.watch.forget(fetch.id);
    this.troubleSince.delete(fetch.id);
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
