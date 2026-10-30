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
import { User } from '@server/entity/User';
import { songNamed } from '@server/lib/music/charts';
import {
  NotTheArtistsSongError,
  UnrequestableSongError,
} from '@server/lib/music/requestSongs';
import type { Song, SongVersion } from '@server/lib/music/songs';
import type { PlaylistLink, SourceSong } from '@server/lib/playlists/sources';
import {
  PlaylistSourceError,
  parsePlaylistLink,
  readPlaylist,
} from '@server/lib/playlists/sources';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { In, IsNull, LessThan, Not } from 'typeorm';

/*
 * Playlists linked to Spotify or Apple Music. Each song is matched to a
 * MusicBrainz recording (in the background, at MusicBrainz's pace) and
 * requested as a song for whoever linked the playlist, within their song
 * limit. What their limit can't take waits and is requested as it frees
 * up; or, with Settings → Music set to have admins approve big imports,
 * an import of more songs than allowed at once waits for an admin, as
 * requests that don't count against the limit. Linked playlists are read
 * again daily for songs added since. No AI is involved.
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

/** The version of a song a playlist means: nearest its length, else best known. */
export const versionFor = (
  song: Song,
  length: number | null | undefined
): SongVersion | undefined => {
  if (length) {
    const near = song.versions
      .filter(
        (v) =>
          v.length != null && Math.abs(v.length - length) <= LENGTH_SLACK_MS
      )
      .sort(
        (a, b) =>
          Math.abs((a.length ?? 0) - length) -
          Math.abs((b.length ?? 0) - length)
      );
    // Among those near enough, the best known (first in MusicBrainz's
    // order) unless another is much nearer: a radio edit and the album
    // version can be seconds apart.
    if (near.length) return near[0];
  }
  return song.versions[0];
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

  /** Looks for a song MusicBrainz didn't know once more, now. */
  public async retry(song: MediaListSong): Promise<void> {
    if (song.state !== 'unmatched' && song.state !== 'failed') return;
    await getRepository(MediaListSong).update(song.id, {
      state: 'matching',
      problem: null,
    });
    this.kick();
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
      let found: Song | null;
      try {
        found = await songNamed(song.title, song.artistName);
      } catch (e) {
        // MusicBrainz is unreachable: tried again on the next pass.
        logger.debug('Could not match a playlist song', {
          label: LABEL,
          errorMessage: describe(e),
        });
        return false;
      }
      const version = found ? versionFor(found, song.length) : undefined;
      await repo.update(
        song.id,
        version
          ? {
              state: 'matched',
              recordingMbid: version.mbId,
              artistMbid: version.artistMbid,
              albumMbid: version.from?.mbId ?? null,
              problem: null,
            }
          : { state: 'unmatched', problem: null }
      );
    }
    return songs.length > MATCH_PER_PASS;
  }

  /** Requests matched songs, for each person, as their limit and settings allow. */
  private async requestWaiting(): Promise<void> {
    const repo = getRepository(MediaListSong);
    const waiting = await repo.find({
      where: { state: In(['matched', 'waiting']) },
      order: { listId: 'ASC', position: 'ASC' },
    });
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
      await this.mark(
        songs.filter((s) => !asked.has(s.recordingMbid as string)),
        'here'
      );
    } catch (e) {
      if (e instanceof NoAlbumsAvailableError) {
        await this.mark(songs, 'here');
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
        // One song spoils the group: each is asked for on its own.
        if (songs.length > 1) {
          for (const song of songs) {
            await this.sendGroup(user, artistMbid, [song], needsApproval);
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
