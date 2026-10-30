import { albumCoverUrl } from '@server/api/coverartarchive';
import { isMbid, musicBrainz } from '@server/api/musicbrainz';
import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
  VARIOUS_ARTISTS_MBID,
} from '@server/constants/media';
import type { SeriesType } from '@server/constants/seriesType';
import { toSeriesTypeFor } from '@server/constants/seriesType';
import { getRepository } from '@server/datasource';
import type {
  MediaRequestBody,
  MusicRequestBody,
} from '@server/interfaces/api/requestInterfaces';
import { resolveRequestAlbums } from '@server/lib/music/requestAlbums';
import type { SongCovered } from '@server/lib/music/requestSongs';
import {
  resolveRequestSongs,
  songsCovered,
} from '@server/lib/music/requestSongs';
import { songFetchProblem } from '@server/lib/music/songFetchReady';
import type { SongRelease, SongVersion } from '@server/lib/music/songs';
import { albumFor, singleFor } from '@server/lib/music/songs';
import notificationManager, { Notification } from '@server/lib/notifications';
import type { NotificationEvent } from '@server/lib/notifications/eventTitles';
import { mediaEvent } from '@server/lib/notifications/eventTitles';
import overrideRules from '@server/lib/overrideRules';
import { Permission } from '@server/lib/permissions';
import { expectedOnApproval } from '@server/lib/requestEta';
import type { RequestServerIssue } from '@server/lib/requestServers';
import { requestServerIssue } from '@server/lib/requestServers';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import requestLock, {
  mediaKey,
  mediaLock,
  userKey,
} from '@server/utils/requestLock';
import { truncate } from 'lodash';
import {
  AfterInsert,
  AfterLoad,
  AfterUpdate,
  Column,
  Entity,
  In,
  Index,
  ManyToOne,
  Not,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import AlbumRequest from './AlbumRequest';
import EpisodeRequest from './EpisodeRequest';
import Media from './Media';
import MusicAlbum from './MusicAlbum';
import SeasonRequest from './SeasonRequest';
import SongRequest from './SongRequest';
import { User } from './User';

export class RequestPermissionError extends Error {}
export class QuotaRestrictedError extends Error {}
export class DuplicateMediaRequestError extends Error {}
export class NoSeasonsAvailableError extends Error {}
export class BlocklistedMediaError extends Error {}
/**
 * Every album or song asked for is already here or already asked for (a
 * song also when an album it is on is).
 */
export class NoAlbumsAvailableError extends Error {}
/** A music request that cannot be made as asked: no albums, too many. */
export class InvalidMusicRequestError extends Error {}

/** How a music request is made, beyond what was asked for. */
export interface MusicRequestOptions {
  /**
   * Waits for an admin, whatever the requester may do on their own, and
   * so isn't counted against their limit: a big playlist import.
   */
  needsApproval?: boolean;
}

/** The most songs one request may ask for. */
export const MAX_SONGS_PER_REQUEST = 50;

/** Why the songs asked for are not requested: each is here or coming. */
const coveredMessage = (
  versions: SongVersion[],
  covered: Map<string, SongCovered>
): string => {
  if (versions.length !== 1) {
    return 'Every song asked for is already here or on its way.';
  }
  const [song] = versions;
  const by = covered.get(song.mbId);
  if (by?.by === 'album') {
    return `${song.songTitle} is on ${
      by.albumTitle || 'an album'
    }, which is already here or on its way.`;
  }
  return `${song.songTitle} is already requested.`;
};

type MediaRequestOptions = {
  isAutoRequest?: boolean;
  /**
   * A series someone chose to follow, asking for a season that has just
   * started. Their earlier automatic request for other seasons must not stop
   * it: the guard below is for automatic requests repeating themselves.
   */
  newSeasonOfFollowedSeries?: boolean;
};

/**
 * On an approval, roughly when the request should arrive — "Digital release
 * expected Nov 3" — as an Expected field. Nothing for other notifications, or
 * when the title is already out.
 */
const approvalExtra = (
  type: Notification,
  request: MediaRequest,
  tmdb: Parameters<typeof expectedOnApproval>[1]
): { name: string; value: string }[] => {
  if (
    type !== Notification.MEDIA_APPROVED &&
    type !== Notification.MEDIA_AUTO_APPROVED
  ) {
    return [];
  }
  const expected = expectedOnApproval(request, tmdb);
  return expected ? [{ name: 'Expected', value: expected }] : [];
};

/** A song as a notification names it: "Song (radio edit)". */
const songName = (song: Pick<SongRequest, 'title' | 'version'>): string =>
  song.version ? `${song.title} (${song.version})` : song.title;

/**
 * What a music notification says, from what Seerr kept when the albums and
 * songs were asked for, so nothing waits on MusicBrainz: "Album — Artist
 * (2003)" for one album, "Song — Artist" for one song, "Artist — 3 albums,
 * 2 songs" for more, with their titles and the first one's cover.
 */
const musicNotification = async (
  request: MediaRequest,
  media: Media
): Promise<{
  subject: string;
  message: string;
  image?: string;
  extra: { name: string; value: string }[];
}> => {
  const asked = [...(request.albums ?? [])].sort((a, b) => a.id - b.id);
  const songs = [...(request.songs ?? [])].sort((a, b) => a.id - b.id);
  const artist = media.foreignTitle || 'Unknown Artist';
  const titles = [...asked.map((album) => album.title), ...songs.map(songName)];

  const counted = (count: number, one: string, many: string) =>
    count ? [`${count} ${count === 1 ? one : many}`] : [];
  let subject = `${artist} — ${[
    ...counted(asked.length, 'album', 'albums'),
    ...counted(songs.length, 'song', 'songs'),
  ].join(', ')}`;
  if (asked.length === 1 && !songs.length) {
    const row = await getRepository(MusicAlbum).findOne({
      where: { mediaId: media.id, mbId: asked[0].albumMbid },
    });
    const year = row?.releaseDate?.slice(0, 4);
    subject = `${asked[0].title} — ${artist}${year ? ` (${year})` : ''}`;
  } else if (songs.length === 1 && !asked.length) {
    subject = `${songName(songs[0])} — ${artist}`;
  }

  const cover = asked[0]?.albumMbid ?? songs[0]?.albumMbid;
  return {
    subject,
    message: truncate(titles.join(', '), {
      length: 500,
      separator: /,? /,
      omission: '…',
    }),
    image: cover ? albumCoverUrl(cover) : undefined,
    extra: [
      ...(asked.length
        ? [{ name: 'Requested Albums', value: String(asked.length) }]
        : []),
      ...(songs.length
        ? [{ name: 'Requested Songs', value: String(songs.length) }]
        : []),
    ],
  };
};

/**
 * Each request's status as last read from or written to the database, so the
 * approval hook can tell a save that changed it from one that only touched
 * another column. Kept beside the entity rather than on it, so it is never
 * sent anywhere with the request.
 */
const savedStatus = new WeakMap<MediaRequest, MediaRequestStatus>();

/**
 * A new request as it stands once saved. Saving it approves it, sends it
 * on and marks its title requested, each on its own copy, so the object
 * that was saved still says what it was beforehand: a request approved at
 * once would still say pending, and its title not yet requested. Read
 * back, unless saving it removed it.
 */
const asSaved = async (request: MediaRequest): Promise<MediaRequest> =>
  (await getRepository(MediaRequest).findOneBy({ id: request.id })) ?? request;

@Entity()
export class MediaRequest {
  public static async request(
    requestBody: MediaRequestBody,
    user: User,
    options: MediaRequestOptions = {}
  ): Promise<MediaRequest> {
    // is4k is optional, and an undefined one binds as null in the duplicate query
    const body = { ...requestBody, is4k: !!requestBody.is4k };

    // Only a caller allowed to set the request user may queue on their lock
    const lockUserId =
      body.userId &&
      user.hasPermission([Permission.MANAGE_USERS, Permission.MANAGE_REQUESTS])
        ? body.userId
        : user.id;

    // No is4k in the key: one media row holds both statuses, so a 4k and a
    // non-4k request for the same title race to create it
    return requestLock.dispatch(userKey(lockUserId), () =>
      mediaLock.dispatch(mediaKey(body.mediaType, body.mediaId), () =>
        MediaRequest.createRequest(body, user, options)
      )
    );
  }

  /**
   * Albums of one artist, as one request: one album, several, or a whole
   * discography, and songs of theirs, one version each. Sent to Lidarr once
   * approved.
   */
  public static async requestMusic(
    requestBody: MusicRequestBody,
    user: User,
    options: MusicRequestOptions = {}
  ): Promise<MediaRequest> {
    const lockUserId =
      requestBody.userId &&
      user.hasPermission([Permission.MANAGE_USERS, Permission.MANAGE_REQUESTS])
        ? requestBody.userId
        : user.id;

    return requestLock.dispatch(userKey(lockUserId), () =>
      mediaLock.dispatch(
        mediaKey(MediaType.MUSIC, requestBody.artistMbid),
        () => MediaRequest.createMusicRequest(requestBody, user, options)
      )
    );
  }

  private static async createMusicRequest(
    requestBody: MusicRequestBody,
    user: User,
    { needsApproval = false }: MusicRequestOptions
  ): Promise<MediaRequest> {
    const mediaRepository = getRepository(Media);
    const requestRepository = getRepository(MediaRequest);
    const albumRepository = getRepository(MusicAlbum);
    const settings = getSettings();

    let requestUser = user;
    if (
      requestBody.userId &&
      !user.hasPermission([Permission.MANAGE_USERS, Permission.MANAGE_REQUESTS])
    ) {
      throw new RequestPermissionError(
        'You do not have permission to modify the request user.'
      );
    } else if (requestBody.userId) {
      requestUser = await getRepository(User).findOneOrFail({
        where: { id: requestBody.userId },
      });
    }

    // Request covers music as it covers films and series; Request Music is
    // for someone who should only ask for music.
    if (
      !requestUser.hasPermission(
        [Permission.REQUEST, Permission.REQUEST_MUSIC],
        { type: 'or' }
      )
    ) {
      throw new RequestPermissionError(
        'You do not have permission to make music requests.'
      );
    }

    const artistMbid = requestBody.artistMbid;
    if (!isMbid(artistMbid)) {
      throw new InvalidMusicRequestError('That is not a MusicBrainz artist.');
    }
    if (artistMbid === VARIOUS_ARTISTS_MBID) {
      throw new InvalidMusicRequestError(
        'Lidarr cannot add Various Artists, so their albums cannot be requested.'
      );
    }
    const asked = [...new Set(requestBody.albums ?? [])];
    const askedSongs = [...new Set(requestBody.songs ?? [])];
    if (askedSongs.length && !settings.music.songRequests) {
      throw new InvalidMusicRequestError(
        'Songs cannot be requested one at a time on this server.'
      );
    }
    if (
      (!asked.length && !askedSongs.length) ||
      ![...asked, ...askedSongs].every(isMbid)
    ) {
      throw new InvalidMusicRequestError(
        'Choose the albums or songs to request.'
      );
    }
    const maxAlbums = settings.music.maxAlbumsPerRequest;
    if (maxAlbums > 0 && asked.length > maxAlbums) {
      throw new InvalidMusicRequestError(
        `One request can ask for at most ${maxAlbums} albums.`
      );
    }
    if (askedSongs.length > MAX_SONGS_PER_REQUEST) {
      throw new InvalidMusicRequestError(
        `One request can ask for at most ${MAX_SONGS_PER_REQUEST} songs.`
      );
    }

    const quotas = await requestUser.getQuota();
    // Songs count against a limit of their own when they have one.
    const songQuota = quotas.song ?? quotas.music;
    const canBypassQuota = user.hasPermission(Permission.MANAGE_REQUESTS);
    // One an admin must approve is not counted: their approval is the check.
    const ignoreQuota =
      needsApproval ||
      (requestBody.ignoreQuota === true &&
        canBypassQuota &&
        ((quotas.music.limit ?? 0) > 0 || (songQuota.limit ?? 0) > 0));

    if (!ignoreQuota) {
      if (requestBody.ignoreQuota && !canBypassQuota) {
        throw new RequestPermissionError(
          'You do not have permission to bypass user quota limits.'
        );
      } else if (
        (asked.length && quotas.music.restricted) ||
        (askedSongs.length && songQuota.restricted)
      ) {
        throw new QuotaRestrictedError('Music Quota exceeded.');
      }
    }

    // Loaded on its own: the artist is changed with update(), never saved
    // with its requests attached.
    const media = await mediaRepository.findOne({
      where: { mediaType: MediaType.MUSIC, foreignId: artistMbid },
    });

    if (media?.status === MediaStatus.BLOCKLISTED) {
      throw new BlocklistedMediaError('This media is blocklisted.');
    }

    const knownAlbums = media
      ? await albumRepository.find({ where: { mediaId: media.id } })
      : [];

    // Albums someone else is already waiting for, and albums already here
    // or on their way, are left out; the rest are requested. One only partly
    // here (songs taken from it) can be asked for whole.
    const openRequests = media
      ? await requestRepository.find({
          where: {
            media: { id: media.id },
            status: Not(
              In([MediaRequestStatus.DECLINED, MediaRequestStatus.COMPLETED])
            ),
          },
        })
      : [];
    const taken = new Set([
      ...openRequests.flatMap((request) =>
        (request.albums ?? []).map((album) => album.albumMbid)
      ),
      ...knownAlbums
        .filter(
          (album) =>
            album.mbId &&
            album.status !== MediaStatus.UNKNOWN &&
            album.status !== MediaStatus.DELETED &&
            album.status !== MediaStatus.PARTIALLY_AVAILABLE
        )
        .map((album) => album.mbId as string),
    ]);
    const wanted = asked.filter((id) => !taken.has(id));

    if (!wanted.length && !askedSongs.length) {
      throw new NoAlbumsAvailableError(
        'Every album asked for is already here or already requested.'
      );
    }

    // Songs already asked for, or on an album here or on its way (this
    // request's own albums too), are left out the same way.
    const versions = await resolveRequestSongs(artistMbid, askedSongs);
    const covered = await songsCovered(versions);
    const songs = versions.filter(
      (version) =>
        !covered.has(version.mbId) &&
        !version.releaseGroups.some((group) => wanted.includes(group.mbId))
    );

    if (!wanted.length && !songs.length) {
      throw new NoAlbumsAvailableError(
        asked.length
          ? 'Every album and song asked for is already here or on its way.'
          : coveredMessage(versions, covered)
      );
    }
    // A song is fetched through a single or EP that has it, or, where
    // Settings → Music allows and Backfill is set up, taken from one of the
    // artist's albums.
    const fromAlbums = !songFetchProblem();
    const unfetchable = songs.find(
      (song) => !singleFor(song) && !(fromAlbums && albumFor(song))
    );
    if (unfetchable) {
      throw new InvalidMusicRequestError(
        fromAlbums
          ? `${unfetchable.songTitle} is only on compilations, so it can't be requested on its own.`
          : `${unfetchable.songTitle} is only on albums, so it can't be requested on its own${
              unfetchable.from
                ? `. Request ${unfetchable.from.title} instead.`
                : '.'
            }`
      );
    }
    if (!ignoreQuota) {
      const over = (quota: typeof songQuota, count: number) =>
        !!quota.limit && count > (quota.remaining ?? 0);
      const left = (quota: typeof songQuota, one: string, many: string) =>
        `You can request ${quota.remaining ?? 0} more ${
          quota.remaining === 1 ? one : many
        }.`;
      if (quotas.song) {
        if (over(quotas.music, wanted.length)) {
          throw new QuotaRestrictedError(left(quotas.music, 'album', 'albums'));
        }
        if (over(quotas.song, songs.length)) {
          throw new QuotaRestrictedError(left(quotas.song, 'song', 'songs'));
        }
      } else if (over(quotas.music, wanted.length + songs.length)) {
        throw new QuotaRestrictedError(
          songs.length
            ? left(quotas.music, 'album or song', 'albums or songs')
            : left(quotas.music, 'album', 'albums')
        );
      }
    }

    const { artistName, albums } = wanted.length
      ? await resolveRequestAlbums(artistMbid, wanted, knownAlbums)
      : {
          artistName: (await musicBrainz().getArtist(artistMbid)).name,
          albums: [],
        };

    let artist: Media;
    if (media) {
      const status =
        media.status === MediaStatus.UNKNOWN ||
        media.status === MediaStatus.DELETED
          ? MediaStatus.PENDING
          : media.status;
      await mediaRepository.update(media.id, {
        status,
        foreignTitle: artistName,
      });
      artist = Object.assign(media, { status, foreignTitle: artistName });
    } else {
      artist = await mediaRepository.save(
        new Media({
          mediaType: MediaType.MUSIC,
          tmdbId: 0,
          foreignId: artistMbid,
          foreignTitle: artistName,
          status: MediaStatus.PENDING,
          status4k: MediaStatus.UNKNOWN,
        })
      );
    }

    // Each album asked for has a row on the artist, waiting like a season.
    for (const album of albums) {
      const row = knownAlbums.find((known) => known.mbId === album.mbId);
      if (row) {
        if (
          row.status === MediaStatus.UNKNOWN ||
          row.status === MediaStatus.DELETED
        ) {
          await albumRepository.update(row.id, {
            status: MediaStatus.PENDING,
          });
        }
      } else {
        await albumRepository.insert(
          new MusicAlbum({
            mediaId: artist.id,
            mbId: album.mbId,
            title: album.title,
            primaryType: album.primaryType ?? null,
            secondaryTypes: album.secondaryTypes,
            releaseDate: album.releaseDate ?? null,
            status: MediaStatus.PENDING,
          })
        );
      }
    }

    // And each single a song is fetched through, waiting the same way.
    const singles = new Map(
      songs
        .map((song) => singleFor(song))
        .filter((single): single is SongRelease => !!single)
        .map((single) => [single.mbId, single])
    );
    for (const single of singles.values()) {
      const row = knownAlbums.find((known) => known.mbId === single.mbId);
      if (!row) {
        await albumRepository.insert(
          new MusicAlbum({
            mediaId: artist.id,
            mbId: single.mbId,
            title: single.title,
            primaryType: single.primaryType,
            secondaryTypes: single.secondaryTypes,
            releaseDate: single.date,
            status: MediaStatus.PENDING,
          })
        );
      } else if (
        row.status === MediaStatus.UNKNOWN ||
        row.status === MediaStatus.DELETED
      ) {
        await albumRepository.update(row.id, { status: MediaStatus.PENDING });
      }
    }

    const autoApproved =
      !needsApproval &&
      user.hasPermission(
        [
          Permission.AUTO_APPROVE,
          Permission.AUTO_APPROVE_MUSIC,
          Permission.MANAGE_REQUESTS,
        ],
        { type: 'or' }
      );
    const status = autoApproved
      ? MediaRequestStatus.APPROVED
      : MediaRequestStatus.PENDING;

    const request = new MediaRequest({
      type: MediaType.MUSIC,
      media: artist,
      requestedBy: requestUser,
      status,
      modifiedBy: autoApproved ? user : undefined,
      is4k: false,
      serverId: requestBody.serverId,
      profileId: requestBody.profileId,
      metadataProfileId: requestBody.metadataProfileId ?? null,
      rootFolder: requestBody.rootFolder,
      tags: requestBody.tags,
      albums: albums.map(
        (album) =>
          new AlbumRequest({
            albumMbid: album.mbId,
            title: album.title,
            status,
          })
      ),
      songs: songs.map(
        (song) =>
          new SongRequest({
            recordingMbid: song.mbId,
            title: song.songTitle,
            version: song.version,
            length: song.length,
            albumMbid: song.from?.mbId ?? null,
            albumTitle: song.from?.title ?? null,
            singleMbid: singleFor(song)?.mbId ?? null,
            singleTitle: singleFor(song)?.title ?? null,
            sourceAlbumMbid: singleFor(song)
              ? null
              : (albumFor(song)?.mbId ?? null),
            sourceAlbumTitle: singleFor(song)
              ? null
              : (albumFor(song)?.title ?? null),
            releaseGroups: song.releaseGroups.map((group) => group.mbId),
            status,
          })
      ),
      isAutoRequest: false,
      ignoreQuota,
    });

    await requestRepository.save(request);
    return asSaved(request);
  }

  private static async createRequest(
    requestBody: MediaRequestBody,
    user: User,
    options: MediaRequestOptions
  ): Promise<MediaRequest> {
    const tmdb = new TheMovieDb();
    const mediaRepository = getRepository(Media);
    const requestRepository = getRepository(MediaRequest);
    const userRepository = getRepository(User);
    const settings = getSettings();

    let requestUser = user;

    if (
      requestBody.userId &&
      !requestUser.hasPermission([
        Permission.MANAGE_USERS,
        Permission.MANAGE_REQUESTS,
      ])
    ) {
      throw new RequestPermissionError(
        'You do not have permission to modify the request user.'
      );
    } else if (requestBody.userId) {
      requestUser = await userRepository.findOneOrFail({
        where: { id: requestBody.userId },
      });
    }

    if (!requestUser) {
      throw new Error('User missing from request context.');
    }

    if (
      requestBody.mediaType === MediaType.MOVIE &&
      !requestUser.hasPermission(
        requestBody.is4k
          ? [Permission.REQUEST_4K, Permission.REQUEST_4K_MOVIE]
          : [Permission.REQUEST, Permission.REQUEST_MOVIE],
        {
          type: 'or',
        }
      )
    ) {
      throw new RequestPermissionError(
        `You do not have permission to make ${
          requestBody.is4k ? '4K ' : ''
        }movie requests.`
      );
    } else if (
      requestBody.mediaType === MediaType.TV &&
      !requestUser.hasPermission(
        requestBody.is4k
          ? [Permission.REQUEST_4K, Permission.REQUEST_4K_TV]
          : [Permission.REQUEST, Permission.REQUEST_TV],
        {
          type: 'or',
        }
      )
    ) {
      throw new RequestPermissionError(
        `You do not have permission to make ${
          requestBody.is4k ? '4K ' : ''
        }series requests.`
      );
    }

    const quotas = await requestUser.getQuota();

    const canBypassQuota = user.hasPermission(Permission.MANAGE_REQUESTS);
    const ignoreQuota =
      requestBody.ignoreQuota === true &&
      canBypassQuota &&
      ((requestBody.mediaType === MediaType.MOVIE
        ? quotas.movie.limit
        : quotas.tv.limit) ?? 0) > 0;

    if (!ignoreQuota) {
      if (requestBody.ignoreQuota && !canBypassQuota) {
        throw new RequestPermissionError(
          'You do not have permission to bypass user quota limits.'
        );
      } else if (
        requestBody.mediaType === MediaType.MOVIE &&
        quotas.movie.restricted
      ) {
        throw new QuotaRestrictedError('Movie Quota exceeded.');
      } else if (
        requestBody.mediaType === MediaType.TV &&
        quotas.tv.restricted
      ) {
        throw new QuotaRestrictedError('Series Quota exceeded.');
      }
    }

    const tmdbMedia =
      requestBody.mediaType === MediaType.MOVIE
        ? await tmdb.getMovie({ movieId: requestBody.mediaId })
        : await tmdb.getTvShow({ tvId: requestBody.mediaId });

    let media = await mediaRepository.findOne({
      where: {
        tmdbId: requestBody.mediaId,
        mediaType: requestBody.mediaType,
      },
      relations: ['requests'],
    });

    if (!media) {
      /*
       * tvdbId is unique across the whole media table, but media is looked up
       * by tmdbId — so a TVDB id that already belongs to another title makes
       * the insert fail and loses the request entirely. It happens when Plex
       * maps two TMDB entries onto one TVDB id, typically a remake and its
       * original.
       *
       * The id is only used to find the series in Sonarr, so dropping it is
       * far better than dropping the request: the title still gets created
       * and requested, and the warning names the collision so it can be
       * sorted out.
       */
      let tvdbId = requestBody.tvdbId ?? tmdbMedia.external_ids.tvdb_id;

      if (tvdbId) {
        const conflicting = await mediaRepository.findOne({
          where: { tvdbId },
        });

        if (conflicting) {
          logger.warn(
            'Another title already holds this TVDB ID; creating without it',
            {
              label: 'Media Request',
              tmdbId: tmdbMedia.id,
              tvdbId,
              conflictingTmdbId: conflicting.tmdbId,
            }
          );

          tvdbId = undefined;
        }
      }

      media = new Media({
        tmdbId: tmdbMedia.id,
        tvdbId,
        status: !requestBody.is4k ? MediaStatus.PENDING : MediaStatus.UNKNOWN,
        status4k: requestBody.is4k ? MediaStatus.PENDING : MediaStatus.UNKNOWN,
        mediaType: requestBody.mediaType,
      });
    } else {
      // Blocklisting sets both, but either one is enough to refuse.
      if (
        media.status === MediaStatus.BLOCKLISTED ||
        media.status4k === MediaStatus.BLOCKLISTED
      ) {
        logger.warn('Request for media blocked due to being blocklisted', {
          tmdbId: tmdbMedia.id,
          mediaType: requestBody.mediaType,
          label: 'Media Request',
        });

        throw new BlocklistedMediaError('This media is blocklisted.');
      }

      // An automatic request for a film already here would only be marked
      // complete at once, telling the user it is available all over again.
      if (
        options.isAutoRequest &&
        requestBody.mediaType === MediaType.MOVIE &&
        media[requestBody.is4k ? 'status4k' : 'status'] ===
          MediaStatus.AVAILABLE
      ) {
        throw new DuplicateMediaRequestError(
          'This movie is already available.'
        );
      }

      if (
        (media.status === MediaStatus.UNKNOWN ||
          media.status === MediaStatus.DELETED) &&
        !requestBody.is4k
      ) {
        media.status = MediaStatus.PENDING;
      }

      if (
        (media.status4k === MediaStatus.UNKNOWN ||
          media.status4k === MediaStatus.DELETED) &&
        requestBody.is4k
      ) {
        media.status4k = MediaStatus.PENDING;
      }
    }

    const existing = await requestRepository
      .createQueryBuilder('request')
      .leftJoinAndSelect('request.media', 'media')
      .leftJoinAndSelect('request.requestedBy', 'user')
      .where('request.is4k = :is4k', { is4k: requestBody.is4k })
      .andWhere('media.tmdbId = :tmdbId', { tmdbId: tmdbMedia.id })
      .andWhere('media.mediaType = :mediaType', {
        mediaType: requestBody.mediaType,
      })
      .getMany();

    if (existing && existing.length > 0) {
      // If any existing movie request is still open (not declined or
      // completed), don't allow a new one. Every one is checked: they come
      // back in no particular order, and an old declined one listed first
      // used to let a duplicate through.
      if (
        requestBody.mediaType === MediaType.MOVIE &&
        existing.some(
          (r) =>
            r.status !== MediaRequestStatus.DECLINED &&
            r.status !== MediaRequestStatus.COMPLETED
        )
      ) {
        logger.warn('Duplicate request for media blocked', {
          tmdbId: tmdbMedia.id,
          mediaType: requestBody.mediaType,
          is4k: requestBody.is4k,
          label: 'Media Request',
        });

        throw new DuplicateMediaRequestError(
          'Request for this media already exists.'
        );
      }

      // If an existing auto-request for this media exists from the same user,
      // don't allow a new one.
      const statusKey = requestBody.is4k ? 'status4k' : 'status';
      if (
        !options.newSeasonOfFollowedSeries &&
        existing.find(
          (r) =>
            r.requestedBy.id === requestUser.id &&
            r.isAutoRequest &&
            r.media?.[statusKey] !== MediaStatus.DELETED
        )
      ) {
        throw new DuplicateMediaRequestError(
          'Auto-request for this media and user already exists.'
        );
      }
    }

    let rootFolder = requestBody.rootFolder;
    let profileId = requestBody.profileId;
    let tags = requestBody.tags;

    // Anime or not as the requester ticked it, which stands over the
    // title's own setting, rules and detection.
    const chosenSeriesType =
      requestBody.seriesType == null
        ? null
        : toSeriesTypeFor(requestBody.mediaType, requestBody.seriesType);
    // Rules belong to a server, so they are matched against the one the
    // request goes to: the server chosen with it, or else the default one.
    const chosenServerId = (
      requestBody.mediaType === MediaType.MOVIE
        ? settings.radarr
        : settings.sonarr
    ).find((server) => server.id === requestBody.serverId)?.id;
    const ruleResult = await overrideRules({
      mediaType: requestBody.mediaType,
      is4k: requestBody.is4k || false,
      serviceId: chosenServerId,
      tmdbMedia,
      requestUser,
      tags,
      animeSetting: chosenSeriesType
        ? chosenSeriesType === 'anime'
        : media.animeSetting,
    });
    const isAdvanced = user.hasPermission(
      [Permission.MANAGE_REQUESTS, Permission.REQUEST_ADVANCED],
      { type: 'or' }
    );
    // Advanced users pick these in the modal, so we don't want to override them if they are set
    const overrideRulesResult = isAdvanced
      ? {
          rootFolder: rootFolder ? null : ruleResult.rootFolder,
          profileId: profileId ? null : ruleResult.profileId,
          tags: tags ? null : ruleResult.tags,
        }
      : ruleResult;
    if (overrideRulesResult.rootFolder) {
      rootFolder = overrideRulesResult.rootFolder;
    }
    if (overrideRulesResult.profileId) {
      profileId = overrideRulesResult.profileId;
    }
    if (overrideRulesResult.tags) {
      tags = overrideRulesResult.tags;
    }
    // The requester's choice, or else a matching rule's series type unless
    // it disagrees with the title's own setting, which then decides when the
    // request is sent (lib/animeDecision). For a movie, only 'anime' or
    // 'standard'.
    const ruleSeriesType =
      ruleResult.seriesType &&
      (media.animeSetting == null ||
        (ruleResult.seriesType === 'anime') === media.animeSetting)
        ? ruleResult.seriesType
        : null;
    const seriesType = chosenSeriesType ?? ruleSeriesType;
    if (
      overrideRulesResult.rootFolder ||
      overrideRulesResult.profileId ||
      overrideRulesResult.tags ||
      (!chosenSeriesType && ruleSeriesType)
    ) {
      logger.debug('Override rule applied.', {
        label: 'Override Rules',
        overrides: overrideRulesResult,
      });
    }

    if (requestBody.mediaType === MediaType.MOVIE) {
      await mediaRepository.save(media);

      const request = new MediaRequest({
        type: MediaType.MOVIE,
        media,
        requestedBy: requestUser,
        // If the user is an admin or has the "auto approve" permission, automatically approve the request
        status: user.hasPermission(
          [
            requestBody.is4k
              ? Permission.AUTO_APPROVE_4K
              : Permission.AUTO_APPROVE,
            requestBody.is4k
              ? Permission.AUTO_APPROVE_4K_MOVIE
              : Permission.AUTO_APPROVE_MOVIE,
            Permission.MANAGE_REQUESTS,
          ],
          { type: 'or' }
        )
          ? MediaRequestStatus.APPROVED
          : MediaRequestStatus.PENDING,
        modifiedBy: user.hasPermission(
          [
            requestBody.is4k
              ? Permission.AUTO_APPROVE_4K
              : Permission.AUTO_APPROVE,
            requestBody.is4k
              ? Permission.AUTO_APPROVE_4K_MOVIE
              : Permission.AUTO_APPROVE_MOVIE,
            Permission.MANAGE_REQUESTS,
          ],
          { type: 'or' }
        )
          ? user
          : undefined,
        is4k: requestBody.is4k,
        serverId: requestBody.serverId,
        profileId: profileId,
        rootFolder: rootFolder,
        tags: tags,
        seriesType,
        isAutoRequest: options.isAutoRequest ?? false,
        ignoreQuota,
      });

      await requestRepository.save(request);
      return asSaved(request);
    } else {
      const tmdbMediaShow = tmdbMedia as Awaited<
        ReturnType<typeof tmdb.getTvShow>
      >;
      let requestedSeasons =
        requestBody.seasons === 'all'
          ? tmdbMediaShow.seasons
              .filter(
                (season) =>
                  season.season_number !== 0 && season.episode_count > 0
              )
              .map((season) => season.season_number)
          : (requestBody.seasons as number[]);
      if (!settings.main.enableSpecialEpisodes) {
        requestedSeasons = requestedSeasons.filter((sn) => sn > 0);
      }

      let existingSeasons: number[] = [];

      // We need to check existing requests on this title to make sure we don't double up on seasons that were
      // already requested. In the case they were, we just throw out any duplicates but still approve the request.
      // (Unless there are no seasons, in which case we abort)
      if (media.requests) {
        existingSeasons = media.requests
          .filter(
            (request) =>
              request.is4k === requestBody.is4k &&
              request.status !== MediaRequestStatus.DECLINED &&
              request.status !== MediaRequestStatus.COMPLETED
          )
          .reduce((seasons, request) => {
            const combinedSeasons = request.seasons.map(
              (season) => season.seasonNumber
            );

            return [...seasons, ...combinedSeasons];
          }, [] as number[]);
      }

      // We should also check seasons that are available/partially available but don't have existing requests
      if (media.seasons) {
        existingSeasons = [
          ...existingSeasons,
          ...media.seasons
            .filter(
              (season) =>
                season[requestBody.is4k ? 'status4k' : 'status'] !==
                  MediaStatus.UNKNOWN &&
                season[requestBody.is4k ? 'status4k' : 'status'] !==
                  MediaStatus.DELETED
            )
            .map((season) => season.seasonNumber),
        ];
      }

      const finalSeasons = requestedSeasons.filter(
        (rs) => !existingSeasons.includes(rs)
      );

      if (finalSeasons.length === 0) {
        throw new NoSeasonsAvailableError('No seasons available to request');
      } else if (
        !ignoreQuota &&
        quotas.tv.limit &&
        finalSeasons.length > (quotas.tv.remaining ?? 0)
      ) {
        throw new QuotaRestrictedError('Series Quota exceeded.');
      }

      await mediaRepository.save(media);

      const request = new MediaRequest({
        type: MediaType.TV,
        media,
        requestedBy: requestUser,
        // If the user is an admin or has the "auto approve" permission, automatically approve the request
        status: user.hasPermission(
          [
            requestBody.is4k
              ? Permission.AUTO_APPROVE_4K
              : Permission.AUTO_APPROVE,
            requestBody.is4k
              ? Permission.AUTO_APPROVE_4K_TV
              : Permission.AUTO_APPROVE_TV,
            Permission.MANAGE_REQUESTS,
          ],
          { type: 'or' }
        )
          ? MediaRequestStatus.APPROVED
          : MediaRequestStatus.PENDING,
        modifiedBy: user.hasPermission(
          [
            requestBody.is4k
              ? Permission.AUTO_APPROVE_4K
              : Permission.AUTO_APPROVE,
            requestBody.is4k
              ? Permission.AUTO_APPROVE_4K_TV
              : Permission.AUTO_APPROVE_TV,
            Permission.MANAGE_REQUESTS,
          ],
          { type: 'or' }
        )
          ? user
          : undefined,
        is4k: requestBody.is4k,
        serverId: requestBody.serverId,
        profileId: profileId,
        rootFolder: rootFolder,
        languageProfileId: requestBody.languageProfileId,
        tags: tags,
        seriesType,
        seasons: finalSeasons.map(
          (sn) =>
            new SeasonRequest({
              seasonNumber: sn,
              episodes: (requestBody.episodes?.[sn] ?? []).map(
                (episodeNumber) => new EpisodeRequest({ episodeNumber })
              ),
              status: user.hasPermission(
                [
                  requestBody.is4k
                    ? Permission.AUTO_APPROVE_4K
                    : Permission.AUTO_APPROVE,
                  requestBody.is4k
                    ? Permission.AUTO_APPROVE_4K_TV
                    : Permission.AUTO_APPROVE_TV,
                  Permission.MANAGE_REQUESTS,
                ],
                { type: 'or' }
              )
                ? MediaRequestStatus.APPROVED
                : MediaRequestStatus.PENDING,
            })
        ),
        isAutoRequest: options.isAutoRequest ?? false,
        ignoreQuota,
      });

      await requestRepository.save(request);
      return asSaved(request);
    }
  }

  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'integer' })
  @Index()
  public status: MediaRequestStatus;

  @ManyToOne(() => Media, (media) => media.requests, {
    eager: true,
    onDelete: 'CASCADE',
  })
  @Index()
  public media: Media;

  /**
   * Set when the requester turns off notifications for their own request.
   * Muting is separate from the request itself, so the request stands until
   * it is deliberately deleted.
   */
  @Column({ default: false })
  public requesterMuted: boolean;

  /**
   * Why it was declined, in the words of whoever declined it, if they gave
   * a reason. Shown to the requester and to admins, and sent in the
   * declined notification. Plain text, never markup.
   */
  @Column({ type: 'varchar', nullable: true })
  public declineReason?: string | null;

  @ManyToOne(() => User, (user) => user.requests, {
    eager: true,
    onDelete: 'CASCADE',
  })
  @Index()
  public requestedBy: User;

  @ManyToOne(() => User, {
    nullable: true,
    eager: true,
    onDelete: 'SET NULL',
  })
  @Index()
  public modifiedBy?: User;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  @Column({ type: 'varchar' })
  public type: MediaType;

  /**
   * Season count, populated by whichever query needs it rather than by
   * TypeORM's @RelationCount. That decorator ran a parallel batch of count
   * queries on one connection, which pg deprecates.
   */
  public seasonCount?: number;

  @OneToMany(() => SeasonRequest, (season) => season.request, {
    eager: true,
    cascade: true,
  })
  public seasons: SeasonRequest[];

  /** For music: the albums asked for. */
  @OneToMany(() => AlbumRequest, (album) => album.request, {
    eager: true,
    cascade: true,
  })
  public albums: AlbumRequest[];

  /** For music: the songs asked for, each one version of a song. */
  @OneToMany(() => SongRequest, (song) => song.request, {
    eager: true,
    cascade: true,
  })
  public songs: SongRequest[];

  @Column({ default: false })
  public is4k: boolean;

  @Column({ nullable: true })
  public serverId: number;

  @Column({ nullable: true })
  public profileId: number;

  @Column({ nullable: true })
  public rootFolder: string;

  @Column({ nullable: true })
  public languageProfileId: number;

  /** For music: the Lidarr metadata profile chosen for the artist. */
  @Column({ type: 'int', nullable: true })
  public metadataProfileId?: number | null;

  /**
   * Anime or not for this request, as its requester ticked it or as an
   * override rule set it (a rule's may be any Sonarr series type); for a
   * movie, only 'anime' or 'standard'. Null leaves it to the title's own
   * setting (Media.animeSetting) and then anime detection (lib/animeDecision).
   */
  @Column({ type: 'varchar', nullable: true })
  public seriesType?: SeriesType | null;

  @Column({
    type: 'text',
    nullable: true,
    transformer: {
      from: (value: string | null): number[] | null => {
        if (value) {
          if (value === 'none') {
            return [];
          }
          return value.split(',').map((v) => Number(v));
        }
        return null;
      },
      to: (value: number[] | null): string | null => {
        if (value) {
          const finalValue = value.join(',');

          // We want to keep the actual state of an "empty array" so we use
          // the keyword "none" to track this.
          if (!finalValue) {
            return 'none';
          }

          return finalValue;
        }
        return null;
      },
    },
  })
  public tags?: number[];

  @Column({ default: false })
  public isAutoRequest: boolean;

  @Column({ default: false })
  public ignoreQuota: boolean;

  /**
   * Why a request still to be sent (pending or failed) has no server to go
   * to: its Radarr, Sonarr or Lidarr server was removed, or there is none.
   * Worked out from the settings whenever it is loaded; never stored.
   */
  public serverIssue?: RequestServerIssue;

  /**
   * A line for the title's history to go with the change of status this
   * save makes (where Retry sent it, say). Never stored.
   */
  public historyNote?: string;

  constructor(init?: Partial<MediaRequest>) {
    Object.assign(this, init);
  }

  @AfterInsert()
  public async notifyNewRequest(): Promise<void> {
    if (this.status === MediaRequestStatus.PENDING) {
      const mediaRepository = getRepository(Media);
      const media = await mediaRepository.findOne({
        where: { id: this.media.id },
      });
      if (!media) {
        logger.error('Media data not found', {
          label: 'Media Request',
          requestId: this.id,
          mediaId: this.media.id,
        });
        return;
      }

      MediaRequest.sendNotification(this, media, Notification.MEDIA_PENDING);

      if (this.isAutoRequest) {
        MediaRequest.sendNotification(
          this,
          media,
          Notification.MEDIA_AUTO_REQUESTED
        );
      }
    }
  }

  /**
   * Notification for approval
   *
   * We only check on AfterUpdate as to not trigger this for
   * auto approved content
   */
  @AfterUpdate()
  public async notifyApprovedOrDeclined(autoApproved = false): Promise<void> {
    // Read once: sending the request on can mark it complete while the media
    // is looked up below, and a request no longer approved must not then be
    // reported as declined.
    const status = this.status;
    const before = savedStatus.get(this);
    savedStatus.set(this, status);

    // A save that left the status as it was (a change to the request's
    // options, say) is not a new approval or decline, and telling everyone
    // again would be wrong.
    if (!autoApproved && before !== undefined && before === status) {
      return;
    }

    if (
      status === MediaRequestStatus.APPROVED ||
      status === MediaRequestStatus.DECLINED
    ) {
      const mediaRepository = getRepository(Media);
      const media = await mediaRepository.findOne({
        where: { id: this.media.id },
      });
      if (!media) {
        logger.error('Media data not found', {
          label: 'Media Request',
          requestId: this.id,
          mediaId: this.media.id,
        });
        return;
      }

      // An artist counts as available for the albums it has, not for the
      // new ones a request asks for.
      if (
        status === MediaRequestStatus.APPROVED &&
        this.type !== MediaType.MUSIC &&
        media[this.is4k ? 'status4k' : 'status'] === MediaStatus.AVAILABLE
      ) {
        logger.info(
          'Media is already available. Sending availability notification instead of approval.',
          { label: 'Media Request', requestId: this.id, mediaId: this.media.id }
        );
        MediaRequest.sendNotification(
          this,
          media,
          Notification.MEDIA_AVAILABLE
        );
        return;
      }

      MediaRequest.sendNotification(
        this,
        media,
        status === MediaRequestStatus.APPROVED
          ? autoApproved
            ? Notification.MEDIA_AUTO_APPROVED
            : Notification.MEDIA_APPROVED
          : Notification.MEDIA_DECLINED
      );

      if (
        status === MediaRequestStatus.APPROVED &&
        autoApproved &&
        this.isAutoRequest
      ) {
        MediaRequest.sendNotification(
          this,
          media,
          Notification.MEDIA_AUTO_REQUESTED
        );
      }
    }
  }

  @AfterInsert()
  public async autoapprovalNotification(): Promise<void> {
    savedStatus.set(this, this.status);

    if (this.status === MediaRequestStatus.APPROVED) {
      // Not waited for, so a failure here (the media lookup, say) is caught
      // and logged: left unhandled, it would stop the whole server.
      this.notifyApprovedOrDeclined(true).catch((e) => {
        logger.error('Could not send the automatic approval notification', {
          label: 'Media Request',
          requestId: this.id,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
      });
    }
  }

  @AfterLoad()
  private rememberStatus() {
    savedStatus.set(this, this.status);
  }

  @AfterLoad()
  public noteServerIssue(): void {
    this.serverIssue =
      this.status === MediaRequestStatus.PENDING ||
      this.status === MediaRequestStatus.FAILED
        ? requestServerIssue(this)
        : undefined;
  }

  @AfterLoad()
  private sortSeasons() {
    if (Array.isArray(this.seasons)) {
      this.seasons.sort((a, b) => a.id - b.id);
    }
  }

  static async sendNotification(
    entity: MediaRequest,
    media: Media,
    type: Notification,
    /**
     * Overrides the event line. An ongoing series that has only started
     * arriving is not "now available", and saying so sends people looking for
     * episodes that are not there yet. Plain text is shown as written in
     * every channel; one from eventTitles is put in each channel's language.
     */
    eventOverride?: string | NotificationEvent,
    extraFields?: { name: string; value: string }[],
    /**
     * Someone watching this request, not its requester: the notification is
     * sent to them alone, whether or not the requester muted it, and the
     * channels and admins are not told again.
     */
    watcher?: User
  ): Promise<boolean> {
    const tmdb = new TheMovieDb();

    try {
      const titled =
        typeof eventOverride === 'string'
          ? { event: eventOverride }
          : (eventOverride ?? mediaEvent(type, entity.type, entity.is4k));
      let notifyAdmin = true;
      let notifySystem = true;
      let notifyRequester = false;

      switch (type) {
        case Notification.MEDIA_AVAILABLE:
        case Notification.MEDIA_APPROVED:
        case Notification.MEDIA_DECLINED:
          notifyAdmin = false;
          break;
        case Notification.MEDIA_AUTO_REQUESTED:
          notifyAdmin = false;
          notifySystem = false;
          break;
        case Notification.MEDIA_FAILED:
          notifyRequester = true;
          break;
      }

      const notifyUser = watcher
        ? watcher
        : (notifyAdmin && !notifyRequester) || entity.requesterMuted
          ? undefined
          : entity.requestedBy;

      if (watcher) {
        notifyAdmin = false;
        notifySystem = false;
      }

      if (entity.type === MediaType.MOVIE) {
        const movie = await tmdb.getMovie({ movieId: media.tmdbId });
        notificationManager.sendNotification(type, {
          media,
          request: entity,
          notifyAdmin,
          notifySystem,
          notifyUser,
          ...titled,
          subject: `${movie.title}${
            movie.release_date ? ` (${movie.release_date.slice(0, 4)})` : ''
          }`,
          message: truncate(movie.overview, {
            length: 500,
            separator: /\s/,
            omission: '…',
          }),
          image: movie.poster_path
            ? `https://image.tmdb.org/t/p/w600_and_h900_bestv2${movie.poster_path}`
            : undefined,
          extra: [
            ...approvalExtra(type, entity, movie),
            ...(extraFields ?? []),
          ],
        });
      } else if (entity.type === MediaType.MUSIC) {
        const music = await musicNotification(entity, media);
        notificationManager.sendNotification(type, {
          media,
          request: entity,
          notifyAdmin,
          notifySystem,
          notifyUser,
          ...titled,
          ...music,
          extra: [...music.extra, ...(extraFields ?? [])],
        });
      } else if (entity.type === MediaType.TV) {
        const tv = await tmdb.getTvShow({ tvId: media.tmdbId });
        notificationManager.sendNotification(type, {
          media,
          request: entity,
          notifyAdmin,
          notifySystem,
          notifyUser,
          ...titled,
          subject: `${tv.name}${
            tv.first_air_date ? ` (${tv.first_air_date.slice(0, 4)})` : ''
          }`,
          message: truncate(tv.overview, {
            length: 500,
            separator: /\s/,
            omission: '…',
          }),
          image: tv.poster_path
            ? `https://image.tmdb.org/t/p/w600_and_h900_bestv2${tv.poster_path}`
            : undefined,
          extra: [
            {
              name: 'Requested Seasons',
              value: entity.seasons
                .map((season) => season.seasonNumber)
                .join(', '),
            },
            ...approvalExtra(type, entity, tv),
            ...(extraFields ?? []),
          ],
        });
      }

      return true;
    } catch (e) {
      logger.error('Something went wrong sending media notification(s)', {
        label: 'Notifications',
        errorMessage: e.message,
        requestId: entity.id,
        // Optional: a request can outlive its title. Reading through a
        // missing one here threw from inside the error handler, turning a
        // failed send into an error that aborted the whole reconcile pass.
        mediaId: entity.media?.id ?? media?.id,
      });

      return false;
    }
  }
}

export default MediaRequest;
