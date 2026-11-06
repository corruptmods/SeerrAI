import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import type { PlaylistSongState } from '@server/entity/MediaList';
import { MediaList, MediaListSong } from '@server/entity/MediaList';
import {
  BlocklistedMediaError,
  InvalidMusicRequestError,
  MAX_SONGS_PER_REQUEST,
  MediaRequest,
  NoAlbumsAvailableError,
  QuotaRestrictedError,
  RequestPermissionError,
} from '@server/entity/MediaRequest';
import SongRequest from '@server/entity/SongRequest';
import { User } from '@server/entity/User';
import { featureEnabled } from '@server/lib/features';
import type { CatalogSong } from '@server/lib/music/catalogSong';
import { catalogOn, catalogSong } from '@server/lib/music/catalogSong';
import { songByIsrc, songNamed } from '@server/lib/music/charts';
import {
  NotTheArtistsSongError,
  UnrequestableSongError,
} from '@server/lib/music/requestSongs';
import { songFetchProblem } from '@server/lib/music/songFetchReady';
import type { Song, SongVersion } from '@server/lib/music/songs';
import { albumFor, otherTake, singleFor } from '@server/lib/music/songs';
import { releaseDelivery } from '@server/lib/notificationDelivery';
import notificationManager, { Notification } from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import type { PlaylistLink, SourceSong } from '@server/lib/playlists/sources';
import {
  PlaylistSourceError,
  parsePlaylistLink,
  readPlaylist,
} from '@server/lib/playlists/sources';
import { requestServerIssue } from '@server/lib/requestServers';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import requestLock, { requestKey } from '@server/utils/requestLock';
import { In, IsNull, LessThan, Not } from 'typeorm';

/*
 * Playlists linked to Spotify or Apple Music. Each song is matched to a
 * MusicBrainz recording in the background: by Deezer's ISRC when
 * MusicBrainz has it, else by title, artist and length. It's then requested
 * for whoever linked the playlist, within their song limit; overflow waits
 * until the limit frees up. With "admins approve big imports" on (Settings
 * → Music), an oversized import instead waits for an admin, outside the
 * limit. Linked playlists are re-read daily. No AI is involved.
 */

const LABEL = 'Playlists';
/** Songs matched per pass before requests are made. */
export const MATCH_PER_PASS = 40;
/** Re-read interval for linked playlists. */
const READ_EVERY_MS = 23 * 60 * 60_000;
/**
 * Retry delay for songs MusicBrainz lacks: music is added constantly,
 * though streaming-only songs may never be.
 */
export const UNMATCHED_RETRY_MS = 7 * 24 * 60 * 60_000;
/** Max length difference between a version and the playlist song. */
const LENGTH_SLACK_MS = 8000;

export class PlaylistLinkError extends Error {}

/**
 * True when a version is on the artist's single or EP, or on their album
 * while taking songs from albums is possible. Compilation-only versions
 * aren't.
 */
const fetchable = (version: SongVersion): boolean =>
  !!version.releaseGroups &&
  (!!singleFor(version) || (!songFetchProblem() && !!albumFor(version)));

/**
 * The version a playlist means: nearest in length, else best known,
 * preferring requestable ones. Never a take the title doesn't name (live,
 * remix…), even if nearer in length. Undefined if only those exist.
 */
export const versionFor = (
  song: Song,
  length: number | null | undefined,
  title: string
): SongVersion | undefined => {
  const same = song.versions.filter(
    (v) => !otherTake(`${v.title} ${v.version ?? ''}`, title)
  );
  if (!same.length) return undefined;
  const requestable = same.filter(fetchable);
  const versions = requestable.length ? requestable : same;
  if (length) {
    const near = versions
      .filter(
        (v) =>
          v.length != null && Math.abs(v.length - length) <= LENGTH_SLACK_MS
      )
      .sort(
        (a, b) =>
          Math.abs((a.length ?? 0) - length) -
          Math.abs((b.length ?? 0) - length)
      );
    if (near.length) return near[0];
  }
  return versions[0];
};

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

class Playlists {
  private running = false;
  private again = false;

  /**
   * Links a Spotify or Apple Music playlist and reads its songs, requested
   * for `user`. Throws PlaylistLinkError, or PlaylistSourceError if
   * unreadable.
   */
  public async link(list: MediaList, text: string, user: User): Promise<void> {
    if (list.kind !== 'music') {
      throw new PlaylistLinkError('Only a playlist can be linked.');
    }
    const link = parsePlaylistLink(text);
    if (!link) {
      throw new PlaylistLinkError(
        'That isn’t a link to a Spotify or Apple Music playlist.'
      );
    }
    const playlist = await readPlaylist(link);
    await getRepository(MediaList).update(list.id, {
      sourceUrl: link.url,
      sourceService: link.service,
      sourceName: playlist.name,
      sourceUserId: user.id,
      sourceReadAt: new Date(),
      sourceProblem: null,
    });
    await this.addSongs(list.id, playlist.songs, user.id);
    this.kick();
  }

  /**
   * Retries a song now: unmatched, unrequestable or orphaned songs are
   * matched again; a failed request is retried. Returns why it can't be,
   * if it can't.
   */
  public async retry(song: MediaListSong): Promise<string | undefined> {
    if (
      (song.state === 'requested' || song.state === 'approval') &&
      song.requestId
    ) {
      // Request deleted, or someone else's that the song followed: rematch
      // and request afresh in the owner's name (the old match may be why it
      // was deleted).
      const request = await getRepository(MediaRequest).findOne({
        where: { id: song.requestId },
        relations: { requestedBy: true },
      });
      if (!request || request.requestedBy?.id !== song.requestForId) {
        await getRepository(MediaListSong).update(song.id, {
          state: 'matching',
          requestId: null,
          problem: null,
        });
        this.kick();
        return;
      }
      return this.retryRequest(song.requestId);
    }
    // Held back by a setting: try again in case it now allows.
    if (song.state === 'waiting') {
      this.kick();
      return;
    }
    if (song.state !== 'unmatched' && song.state !== 'failed') return;
    await getRepository(MediaListSong).update(song.id, {
      state: 'matching',
      problem: null,
    });
    this.kick();
  }

  /**
   * Retries a failed request, as the request's Retry button does, for an
   * owner who may still request music and whose requests need no approval.
   * Returns why not, if not.
   */
  private async retryRequest(requestId: number): Promise<string | undefined> {
    return requestLock.dispatch(requestKey(requestId), async () => {
      const repo = getRepository(MediaRequest);
      const request = await repo.findOne({
        where: { id: requestId },
        relations: { requestedBy: true, modifiedBy: true },
      });
      if (request?.status !== MediaRequestStatus.FAILED) return undefined;
      // Like Retry: never for blocklisted media.
      if (
        request.media?.status === MediaStatus.BLOCKLISTED ||
        request.media?.status4k === MediaStatus.BLOCKLISTED
      ) {
        return undefined;
      }
      const owner = request.requestedBy;
      if (
        !owner?.hasPermission([Permission.REQUEST, Permission.REQUEST_MUSIC], {
          type: 'or',
        }) ||
        !owner.hasPermission(
          [
            Permission.MANAGE_REQUESTS,
            Permission.AUTO_APPROVE,
            Permission.AUTO_APPROVE_MUSIC,
          ],
          { type: 'or' }
        )
      ) {
        return 'Its request failed after it was approved, so an admin retries it.';
      }
      // Its server is gone: retrying would only fail again.
      if (requestServerIssue(request)) {
        return 'Its request has no Lidarr server to go to. An admin can edit it to choose one, then retry it.';
      }
      // Release the failure notice so a second failure notifies again.
      await releaseDelivery(request.id, Notification.MEDIA_FAILED);
      // Re-approving picks up its failed songs.
      request.status = MediaRequestStatus.APPROVED;
      await repo.save(request);
      return undefined;
    });
  }

  /** Unlinks the source; existing songs stay. */
  public async unlink(list: MediaList): Promise<void> {
    await getRepository(MediaList).update(list.id, {
      sourceUrl: null,
      sourceService: null,
      sourceName: null,
      sourceUserId: null,
      sourceReadAt: null,
      sourceProblem: null,
    });
  }

  /** Appends new songs for matching. Returns how many were added. */
  private async addSongs(
    listId: number,
    songs: SourceSong[],
    requestForId: number
  ): Promise<number> {
    const repo = getRepository(MediaListSong);
    const known = new Set(
      (await repo.find({ select: { sourceId: true }, where: { listId } })).map(
        (s) => s.sourceId
      )
    );
    const last = await repo.findOne({
      select: { position: true },
      where: { listId },
      order: { position: 'DESC' },
    });
    let position = (last?.position ?? -1) + 1;
    const fresh = songs
      .filter(
        (song, i, all) =>
          !known.has(song.sourceId) &&
          all.findIndex((s) => s.sourceId === song.sourceId) === i
      )
      .map(
        (song) =>
          new MediaListSong({
            listId,
            sourceId: song.sourceId,
            position: position++,
            title: song.title.slice(0, 250),
            artistName: song.artistName.slice(0, 250),
            length: song.length,
            state: 'matching',
            requestForId,
          })
      );
    if (fresh.length) await repo.save(fresh, { chunk: 100 });
    return fresh.length;
  }

  public isRunning(): boolean {
    return this.running;
  }

  /**
   * Hourly job: re-reads playlists due a read, requeues stale unmatched
   * songs, then matches and requests within limits.
   */
  public async sync(now = Date.now()): Promise<void> {
    await getRepository(MediaListSong).update(
      {
        state: 'unmatched',
        updatedAt: LessThan(new Date(now - UNMATCHED_RETRY_MS)),
      },
      { state: 'matching' }
    );
    const lists = await getRepository(MediaList).find({
      where: { kind: 'music', sourceUrl: Not(IsNull()) },
    });
    const due = lists.filter(
      (list) =>
        !list.sourceReadAt ||
        now - new Date(list.sourceReadAt).getTime() >= READ_EVERY_MS
    );
    for (const list of due) {
      const link: PlaylistLink | null = parsePlaylistLink(list.sourceUrl ?? '');
      if (!link || !list.sourceUserId) continue;
      try {
        const playlist = await readPlaylist(link);
        const added = await this.addSongs(
          list.id,
          playlist.songs,
          list.sourceUserId
        );
        await getRepository(MediaList).update(list.id, {
          sourceName: playlist.name,
          sourceReadAt: new Date(),
          sourceProblem: null,
        });
        if (added) {
          logger.info(`${added} new songs on a linked playlist`, {
            label: LABEL,
            listId: list.id,
          });
        }
      } catch (e) {
        const problem = (
          e instanceof PlaylistSourceError ? e.message : 'It could not be read.'
        ).slice(0, 250);
        await getRepository(MediaList).update(list.id, {
          sourceProblem: problem,
        });
        // Notify only when the problem starts; reads continue daily.
        if (!list.sourceProblem) await tellUnreadable(list, problem);
      }
    }
    this.kick();
  }

  /** Matches and requests waiting songs in the background. */
  public kick(): void {
    // Songs wait while Music is off for everyone.
    if (!featureEnabled('music')) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    void (async () => {
      try {
        do {
          this.again = false;
          const more = await this.matchSome();
          await this.requestWaiting();
          if (more) this.again = true;
        } while (this.again);
      } catch (e) {
        logger.warn('Could not get on with playlists', {
          label: LABEL,
          errorMessage: describe(e),
        });
      } finally {
        this.running = false;
      }
    })();
  }

  /** For tests: resolves once matching and requesting are idle. */
  public async settled(): Promise<void> {
    while (this.running) await new Promise((r) => setTimeout(r, 10));
  }

  /** Matches some songs; true when more are waiting. */
  private async matchSome(): Promise<boolean> {
    const repo = getRepository(MediaListSong);
    const songs = await repo.find({
      where: { state: 'matching' },
      order: { id: 'ASC' },
      take: MATCH_PER_PASS + 1,
    });
    for (const song of songs.slice(0, MATCH_PER_PASS)) {
      const pick = (s: Song) => versionFor(s, song.length, song.title);
      // Deezer listing for the ISRC. If Deezer fails, match by name.
      let catalog: CatalogSong | null | undefined;
      if (catalogOn()) {
        catalog = await catalogSong(
          song.title,
          song.artistName,
          song.length
        ).catch((e) => {
          logger.debug('Could not look a playlist song up on Deezer', {
            label: LABEL,
            errorMessage: describe(e),
          });
          return undefined;
        });
      }
      let found: Song | null = null;
      try {
        // Exact recording by ISRC; ignore a code only on another take (a
        // mislabelled live one).
        if (catalog?.isrc) {
          found = await songByIsrc(catalog.isrc, song.artistName, pick);
          if (found && !pick(found)) found = null;
        }
        // An ISRC only on others' compilations: prefer the artist's own
        // recording by name, if requestable and the same length.
        const byCode = found && pick(found);
        if (
          byCode &&
          !fetchable(byCode) &&
          !byCode.releaseGroups.some((group) => group.byArtist)
        ) {
          const named = await songNamed(song.title, song.artistName, pick);
          const own = named && pick(named);
          if (
            own &&
            fetchable(own) &&
            (!song.length ||
              (own.length != null &&
                Math.abs(own.length - song.length) <= LENGTH_SLACK_MS))
          ) {
            found = named;
          }
        }
        found ??= await songNamed(song.title, song.artistName, pick);
      } catch (e) {
        // MusicBrainz unreachable: retry next pass.
        logger.debug('Could not match a playlist song', {
          label: LABEL,
          errorMessage: describe(e),
        });
        return false;
      }
      const version = found ? pick(found) : undefined;
      // Store Deezer's latest answer, when it was asked.
      const listed =
        catalog === undefined
          ? {}
          : { isrc: catalog?.isrc ?? null, catalog: catalog ?? null };
      // Only if still matching, so a song removed meanwhile stays removed.
      await repo.update(
        { id: song.id, state: 'matching' },
        version
          ? {
              state: 'matched',
              recordingMbid: version.mbId,
              artistMbid: version.artistMbid,
              albumMbid: version.from?.mbId ?? null,
              problem: null,
              ...listed,
            }
          : { state: 'unmatched', problem: null, ...listed }
      );
    }
    return songs.length > MATCH_PER_PASS;
  }

  /** Requests matched songs per user within their limit and settings. */
  private async requestWaiting(): Promise<void> {
    const repo = getRepository(MediaListSong);
    let waiting = await repo.find({
      where: { state: In(['matched', 'waiting']) },
      order: { listId: 'ASC', position: 'ASC' },
    });
    // With approval for big imports, hold a playlist until it's fully
    // matched, or each pass would be too small to need approval.
    if (getSettings().music.playlists.overLimit === 'approve') {
      const finding = new Set(
        (
          await repo.find({
            select: { listId: true },
            where: { state: 'matching' },
          })
        ).map((song) => song.listId)
      );
      waiting = waiting.filter((song) => !finding.has(song.listId));
    }
    const byUser = new Map<number, MediaListSong[]>();
    for (const song of waiting) {
      if (!song.requestForId) continue;
      byUser.set(song.requestForId, [
        ...(byUser.get(song.requestForId) ?? []),
        song,
      ]);
    }
    for (const [userId, songs] of byUser) {
      const user = await getRepository(User).findOne({ where: { id: userId } });
      if (!user) {
        await this.mark(
          songs,
          'failed',
          'Who linked it no longer has an account.'
        );
        continue;
      }
      await this.requestFor(user, songs);
    }
  }

  private async mark(
    songs: MediaListSong[],
    state: PlaylistSongState,
    problem: string | null = null,
    requestId?: number
  ): Promise<void> {
    if (!songs.length) return;
    await getRepository(MediaListSong).update(
      { id: In(songs.map((s) => s.id)) },
      { state, problem, ...(requestId ? { requestId } : {}) }
    );
  }

  private async requestFor(user: User, songs: MediaListSong[]): Promise<void> {
    if (!featureEnabled('music', user)) {
      await this.mark(songs, 'waiting', 'Music is turned off.');
      return;
    }
    const settings = getSettings().music;
    if (!settings.songRequests) {
      await this.mark(
        songs,
        'waiting',
        'Songs can’t be requested one at a time on this server.'
      );
      return;
    }
    const { overLimit, approveOver } = settings.playlists;
    const fresh = songs.filter((s) => s.state === 'matched');
    // A big import goes to an admin as one batch, when so configured.
    if (overLimit === 'approve' && fresh.length > approveOver) {
      await this.send(user, fresh, true);
      songs = songs.filter((s) => s.state === 'waiting');
      if (!songs.length) return;
    }
    const quotas = await user.getQuota();
    const quota = quotas.song ?? quotas.music;
    const room = quota.limit ? Math.max(0, quota.remaining ?? 0) : songs.length;
    const now = songs.slice(0, room);
    const later = songs.slice(room);
    await this.mark(later, 'waiting', 'limit');
    if (now.length) await this.send(user, now, false);
  }

  /** Requests songs, one request per artist, and records each outcome. */
  private async send(
    user: User,
    songs: MediaListSong[],
    needsApproval: boolean
  ): Promise<void> {
    const byArtist = new Map<string, MediaListSong[]>();
    for (const song of songs) {
      if (!song.artistMbid || !song.recordingMbid) continue;
      byArtist.set(song.artistMbid, [
        ...(byArtist.get(song.artistMbid) ?? []),
        song,
      ]);
    }
    for (const [artistMbid, ofArtist] of byArtist) {
      for (let i = 0; i < ofArtist.length; i += MAX_SONGS_PER_REQUEST) {
        await this.sendGroup(
          user,
          artistMbid,
          ofArtist.slice(i, i + MAX_SONGS_PER_REQUEST),
          needsApproval
        );
      }
    }
  }

  /**
   * Marks songs already covered: those in another open request follow it
   * (and are re-requested if it's declined); the rest are here.
   */
  private async markCovered(songs: MediaListSong[]): Promise<void> {
    if (!songs.length) return;
    const open = await getRepository(SongRequest).find({
      select: { id: true, recordingMbid: true, status: true },
      where: {
        recordingMbid: In(songs.map((s) => s.recordingMbid as string)),
        status: In([MediaRequestStatus.PENDING, MediaRequestStatus.APPROVED]),
        request: { status: Not(MediaRequestStatus.DECLINED) },
      },
      relations: { request: true },
    });
    const here: MediaListSong[] = [];
    for (const song of songs) {
      const by = open.find((o) => o.recordingMbid === song.recordingMbid);
      if (by) {
        await this.mark(
          [song],
          by.request.status === MediaRequestStatus.PENDING
            ? 'approval'
            : 'requested',
          null,
          by.request.id
        );
      } else {
        here.push(song);
      }
    }
    await this.mark(here, 'here');
  }

  private async sendGroup(
    user: User,
    artistMbid: string,
    songs: MediaListSong[],
    needsApproval: boolean
  ): Promise<void> {
    try {
      const request = await MediaRequest.requestMusic(
        {
          artistMbid,
          songs: songs.map((s) => s.recordingMbid as string),
        },
        user,
        { needsApproval }
      );
      const asked = new Set((request.songs ?? []).map((s) => s.recordingMbid));
      await this.mark(
        songs.filter((s) => asked.has(s.recordingMbid as string)),
        needsApproval ? 'approval' : 'requested',
        null,
        request.id
      );
      // The rest were already here or requested.
      await this.markCovered(
        songs.filter((s) => !asked.has(s.recordingMbid as string))
      );
    } catch (e) {
      if (e instanceof NoAlbumsAvailableError) {
        await this.markCovered(songs);
      } else if (e instanceof QuotaRestrictedError) {
        await this.mark(songs, 'waiting', 'limit');
      } else if (e instanceof RequestPermissionError) {
        await this.mark(songs, 'failed', e.message);
      } else if (
        e instanceof InvalidMusicRequestError ||
        e instanceof NotTheArtistsSongError ||
        e instanceof UnrequestableSongError ||
        e instanceof BlocklistedMediaError
      ) {
        // One bad song fails the group: bisect to isolate it and request the
        // rest in as few requests as possible.
        if (songs.length > 1) {
          const half = Math.ceil(songs.length / 2);
          for (const part of [songs.slice(0, half), songs.slice(half)]) {
            await this.sendGroup(user, artistMbid, part, needsApproval);
          }
        } else {
          await this.mark(songs, 'failed', e.message.slice(0, 250));
        }
      } else {
        // MusicBrainz or Lidarr unreachable: retry next pass.
        logger.warn('Could not request songs from a playlist', {
          label: LABEL,
          errorMessage: describe(e),
        });
      }
    }
  }
}

const playlists = new Playlists();
/** Notifies the owner that the playlist source can't be read. */
const tellUnreadable = async (list: MediaList, problem: string) => {
  try {
    const owner = await getRepository(User).findOne({
      where: { id: list.ownerId },
    });
    if (!owner) return;
    notificationManager.sendNotification(Notification.PLAYLIST_UPDATE, {
      subject: `${list.name}: its playlist can’t be read`,
      message: `${problem} New songs on it aren’t requested until it can be.`,
      notifyAdmin: false,
      notifySystem: false,
      notifyUser: owner,
      actionUrl: `/lists/${list.id}`,
      actionUrlTitle: 'View Playlist',
    });
  } catch (e) {
    logger.error('Could not tell a playlist can’t be read', {
      label: LABEL,
      listId: list.id,
      errorMessage: describe(e),
    });
  }
};

export default playlists;
