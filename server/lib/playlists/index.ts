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
import { Notification } from '@server/lib/notifications';
import type { PlaylistLink, SourceSong } from '@server/lib/playlists/sources';
import {
  PlaylistSourceError,
  parsePlaylistLink,
  readPlaylist,
} from '@server/lib/playlists/sources';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import requestLock, { requestKey } from '@server/utils/requestLock';
import { In, IsNull, LessThan, Not } from 'typeorm';

/*
 * Playlists linked to Spotify or Apple Music. Each song is matched to a
 * MusicBrainz recording (in the background, at MusicBrainz's pace): by its
 * ISRC, as Deezer lists the song, when MusicBrainz has the code, else by
 * its title, artist and length. It is then requested as a song for whoever
 * linked the playlist, within their song limit. What their limit can't
 * take waits and is requested as it frees up; or, with Settings → Music
 * set to have admins approve big imports, an import of more songs than
 * allowed at once waits for an admin, as requests that don't count against
 * the limit. Linked playlists are read again daily for songs added since.
 * No AI is involved.
 */

const LABEL = 'Playlists';
/** Songs matched in one go before the requests are made. */
const MATCH_PER_PASS = 40;
/** How often a linked playlist is read again. */
const READ_EVERY_MS = 23 * 60 * 60_000;
/**
 * How long a song MusicBrainz didn't know waits before it is looked for
 * again: music is added there all the time, though a song only on Spotify
 * or YouTube may never be.
 */
const UNMATCHED_RETRY_MS = 7 * 24 * 60 * 60_000;
/** How close a version's length must be to the playlist's to be it. */
const LENGTH_SLACK_MS = 8000;

export class PlaylistLinkError extends Error {}

/**
 * Whether a version can be requested: on a single or EP of the artist's,
 * or, while songs may be taken from albums, on one of their albums. One
 * only on others' compilations ("Now That's…") can't be.
 */
const fetchable = (version: SongVersion): boolean =>
  !!version.releaseGroups &&
  (!!singleFor(version) || (!songFetchProblem() && !!albumFor(version)));

/**
 * The version of a song a playlist means: nearest its length, else best
 * known; among those that can be requested, when any can. Never a take the
 * playlist's title doesn't name (live, acoustic, a remix…): one can be
 * nearer its length than the song itself. None when there are only those.
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
   * Links a playlist to a Spotify or Apple Music playlist and reads its
   * songs, requested for `user`. Throws PlaylistLinkError, or
   * PlaylistSourceError when it can't be read.
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
   * Tries a song once more, now: one MusicBrainz didn't know, that couldn't
   * be requested, or whose request was deleted, is looked for again; one
   * whose request failed (its album couldn't be got) has its request tried
   * again.
   */
  public async retry(song: MediaListSong): Promise<void> {
    if (
      (song.state === 'requested' || song.state === 'approval') &&
      song.requestId
    ) {
      // Its request was deleted, or was someone else's that the song only
      // followed: looked up again and asked for afresh, in the owner's name.
      // What it was matched to may be why it was deleted.
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
      await this.retryRequest(song.requestId);
      return;
    }
    // Held back by a setting: asked for again, if it now allows.
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

  /** A failed request tried again, as Retry on the request does. */
  private async retryRequest(requestId: number): Promise<void> {
    await requestLock.dispatch(requestKey(requestId), async () => {
      const repo = getRepository(MediaRequest);
      const request = await repo.findOne({
        where: { id: requestId },
        relations: { requestedBy: true, modifiedBy: true },
      });
      if (request?.status !== MediaRequestStatus.FAILED) return;
      // As Retry on the request: never one of something blocklisted.
      if (
        request.media?.status === MediaStatus.BLOCKLISTED ||
        request.media?.status4k === MediaStatus.BLOCKLISTED
      ) {
        return;
      }
      // Told once; a second failure after this is told again.
      await releaseDelivery(request.id, Notification.MEDIA_FAILED);
      // Approving it again takes its failed songs up again.
      request.status = MediaRequestStatus.APPROVED;
      await repo.save(request);
    });
  }

  /** Unlinks it: its songs stay, and nothing new is read. */
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

  /** Songs new to the list, at the end of it, to be matched. */
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
   * The hourly job: linked playlists not read for a day are read again,
   * and what waits is matched and requested as limits allow.
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
        await getRepository(MediaList).update(list.id, {
          sourceProblem: (e instanceof PlaylistSourceError
            ? e.message
            : 'It could not be read.'
          ).slice(0, 250),
        });
      }
    }
    this.kick();
  }

  /** Matches and requests what is waiting, in the background. */
  public kick(): void {
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

  /** Settles once nothing is being matched or requested (for tests). */
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
      // The song as the stores list it, for its ISRC. Deezer not answering
      // is no reason to wait: the song is matched by name meanwhile.
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
        // The very recording, when MusicBrainz has its code; a code on only
        // another take of it (a live one, mislabelled) is passed over.
        if (catalog?.isrc) {
          found = await songByIsrc(catalog.isrc, song.artistName, pick);
          if (found && !pick(found)) found = null;
        }
        found ??= await songNamed(song.title, song.artistName, pick);
      } catch (e) {
        // MusicBrainz is unreachable: tried again on the next pass.
        logger.debug('Could not match a playlist song', {
          label: LABEL,
          errorMessage: describe(e),
        });
        return false;
      }
      const version = found ? pick(found) : undefined;
      // Deezer's listing, when it was asked: kept as it last said.
      const listed =
        catalog === undefined
          ? {}
          : { isrc: catalog?.isrc ?? null, catalog: catalog ?? null };
      // Only while it is still being found: taken off the playlist
      // meanwhile, it stays off.
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

  /** Requests matched songs, for each person, as their limit and settings allow. */
  private async requestWaiting(): Promise<void> {
    const repo = getRepository(MediaListSong);
    let waiting = await repo.find({
      where: { state: In(['matched', 'waiting']) },
      order: { listId: 'ASC', position: 'ASC' },
    });
    // A big import waiting for an admin goes as one batch: none of a
    // playlist's songs is asked for while others of it are still being
    // found, or each pass of them would be too few to need approval.
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
    // A big import waits for an admin as one batch, when that is chosen.
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

  /** Requests songs, one request per artist, and notes what became of each. */
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
   * Songs already here or on their way: one on its way in someone else's
   * request follows that request (and is asked for afresh should it be
   * declined); the rest are here.
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
      // The rest were here already, or on their way.
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
        // One song spoils the group: it is found by halves, the rest asked
        // for in as few requests as that leaves.
        if (songs.length > 1) {
          const half = Math.ceil(songs.length / 2);
          for (const part of [songs.slice(0, half), songs.slice(half)]) {
            await this.sendGroup(user, artistMbid, part, needsApproval);
          }
        } else {
          await this.mark(songs, 'failed', e.message.slice(0, 250));
        }
      } else {
        // MusicBrainz or Lidarr unreachable: tried again on the next pass.
        logger.warn('Could not request songs from a playlist', {
          label: LABEL,
          errorMessage: describe(e),
        });
      }
    }
  }
}

const playlists = new Playlists();
export default playlists;
