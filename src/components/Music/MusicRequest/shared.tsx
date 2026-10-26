import Badge from '@app/components/Common/Badge';
import Tooltip from '@app/components/Common/Tooltip';
import MusicStatusBadge from '@app/components/Music/MusicStatusBadge';
import {
  albumDownloads,
  artistImageUrl,
  musicRequestStatus,
  songName,
} from '@app/components/Music/musicHelpers';
import useRequestAction from '@app/hooks/useRequestAction';
import useRetryRequest from '@app/hooks/useRetryRequest';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  refreshIntervalHelper,
  watchRequest,
} from '@app/utils/refreshIntervalHelper';
import { albumCoverUrl } from '@server/api/coverartarchive';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { NonFunctionProperties } from '@server/interfaces/api/common';
import axios from 'axios';
import { useState } from 'react';
import type { IntlShape } from 'react-intl';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';

/*
 * What a music request's card and list row share: how it is named, where
 * it links, its picture, its albums and songs, its status, and approving, retrying
 * and removing it. Nothing here asks TMDB: music has no TMDB id.
 */

export const messages = defineMessages('components.Music.MusicRequest', {
  albumCount: '{count, plural, one {# album} other {# albums}}',
  albums: '{count, plural, one {Album} other {Albums}}',
  songCount: '{count, plural, one {# song} other {# songs}}',
  songs: '{count, plural, one {Song} other {Songs}}',
  unknownArtist: 'Unknown Artist',
  failedretry: 'Something went wrong while retrying the request.',
  failedmodify: 'Something went wrong while modifying the request.',
});

type Request = NonFunctionProperties<MediaRequest>;

const albumsOf = (request: Request) =>
  [...(request.albums ?? [])].sort((a, b) => a.id - b.id);

const songsOf = (request: Request) =>
  [...(request.songs ?? [])].sort((a, b) => a.id - b.id);

/** The one album, or one song, a request asked for, if that is all. */
const onlyOne = (request: Request) => {
  const albums = albumsOf(request);
  const songs = songsOf(request);
  if (albums.length === 1 && !songs.length) {
    return { title: albums[0].title, albumMbid: albums[0].albumMbid };
  }
  if (songs.length === 1 && !albums.length) {
    return {
      title: songName(songs[0].title, songs[0].version),
      albumMbid: songs[0].albumMbid ?? undefined,
    };
  }
  return undefined;
};

/** "Artist — Album", "Artist — Song", or "Artist — 3 albums, 2 songs". */
/** Whom a music request is for. */
export const musicRequestArtist = (request: Request, intl: IntlShape): string =>
  request.media?.foreignTitle || intl.formatMessage(messages.unknownArtist);

/** What a music request asks for: the one album or song, or how many. */
export const musicRequestName = (request: Request, intl: IntlShape): string => {
  const one = onlyOne(request);
  if (one) {
    return one.title;
  }
  const albums = albumsOf(request).length;
  const songs = songsOf(request).length;
  return [
    albums || !songs
      ? intl.formatMessage(messages.albumCount, { count: albums })
      : undefined,
    songs
      ? intl.formatMessage(messages.songCount, { count: songs })
      : undefined,
  ]
    .filter(Boolean)
    .join(', ');
};

export const musicRequestTitle = (request: Request, intl: IntlShape): string =>
  `${musicRequestArtist(request, intl)} — ${musicRequestName(request, intl)}`;

/**
 * The album's page for one album (or the one a song is from), the
 * artist's for more.
 */
export const musicRequestHref = (request: Request): string => {
  const album = onlyOne(request)?.albumMbid;
  return album
    ? `/music/album/${album}`
    : `/music/artist/${request.media?.foreignId}`;
};

/**
 * The album's cover for one album (or the one a song is from), a picture
 * of the artist otherwise.
 */
export const musicRequestImage = (request: Request): string | undefined => {
  const album = onlyOne(request)?.albumMbid;
  if (album) {
    return albumCoverUrl(album);
  }
  return request.media?.foreignId
    ? artistImageUrl(request.media.foreignId)
    : undefined;
};

/** What stands in for a missing picture: a record, or a person. */
export const musicRequestFallback = (request: Request): 'album' | 'artist' =>
  onlyOne(request)?.albumMbid ? 'album' : 'artist';

/** A song asked for, as a status: waiting, on its way, or here. */
const SONG_STATUS: Partial<Record<MediaRequestStatus, MediaStatus>> = {
  [MediaRequestStatus.PENDING]: MediaStatus.PENDING,
  [MediaRequestStatus.APPROVED]: MediaStatus.PROCESSING,
  [MediaRequestStatus.COMPLETED]: MediaStatus.AVAILABLE,
};

/** How many songs, with each one and where it is, on hover. */
export const SongsField = ({
  request,
  className = 'card-field',
}: {
  request: Request;
  className?: string;
}) => {
  const intl = useIntl();
  const songs = songsOf(request);
  if (!songs.length) {
    return null;
  }
  return (
    <div className={className}>
      <span className="card-field-name">
        {intl.formatMessage(messages.songs, { count: songs.length })}
      </span>
      <Tooltip
        content={
          <ul className="space-y-1 text-left">
            {songs.map((song) => (
              <li key={song.id} className="flex items-center gap-2">
                <span className="min-w-0">
                  <span className="block truncate">
                    {songName(song.title, song.version)}
                  </span>
                  {song.fetchStage && (
                    <span className="block truncate text-xs text-muted">
                      {song.fetchStage}
                    </span>
                  )}
                </span>
                <MusicStatusBadge
                  status={SONG_STATUS[song.status]}
                  downloads={
                    song.singleMbid
                      ? albumDownloads(
                          request.media?.downloadStatus,
                          song.singleMbid
                        )
                      : []
                  }
                  plain
                />
              </li>
            ))}
          </ul>
        }
      >
        <span>
          <Badge>{songs.length}</Badge>
        </span>
      </Tooltip>
    </div>
  );
};

/** How many albums, with each one and where it is, on hover. */
export const AlbumsField = ({
  request,
  className = 'card-field',
}: {
  request: Request;
  className?: string;
}) => {
  const intl = useIntl();
  const albums = albumsOf(request);
  if (!albums.length) {
    return null;
  }
  return (
    <div className={className}>
      <span className="card-field-name">
        {intl.formatMessage(messages.albums, { count: albums.length })}
      </span>
      <Tooltip
        content={
          <ul className="space-y-1 text-left">
            {albums.map((album) => (
              <li key={album.id} className="flex items-center gap-2">
                <span className="truncate">{album.title}</span>
                <MusicStatusBadge
                  status={album.albumStatus}
                  downloads={albumDownloads(
                    request.media?.downloadStatus,
                    album.albumMbid
                  )}
                  addingToLibrary={album.addingToLibrary}
                  plain
                />
              </li>
            ))}
          </ul>
        }
      >
        <span>
          <Badge>{albums.length}</Badge>
        </span>
      </Tooltip>
    </div>
  );
};

/** The request's status, as far as its albums have come. */
export const MusicRequestBadge = ({ request }: { request: Request }) => {
  const intl = useIntl();
  if (request.status === MediaRequestStatus.DECLINED) {
    return (
      <Badge badgeType="danger">
        {intl.formatMessage(globalMessages.declined)}
      </Badge>
    );
  }
  if (request.status === MediaRequestStatus.FAILED) {
    return (
      <Badge badgeType="danger" href={musicRequestHref(request)}>
        {intl.formatMessage(globalMessages.failed)}
      </Badge>
    );
  }
  const status = musicRequestStatus(request);
  const albums = albumsOf(request);
  return status === MediaStatus.UNKNOWN ? null : (
    <MusicStatusBadge
      status={status}
      downloads={albumDownloads(request.media?.downloadStatus, [
        ...albums.map((album) => album.albumMbid),
        // The singles its songs come on.
        ...songsOf(request).flatMap((song) =>
          song.singleMbid ? [song.singleMbid] : []
        ),
      ])}
      addingToLibrary={albums.some((album) => album.addingToLibrary)}
      artistId={request.media?.foreignId ?? undefined}
      title={musicRequestTitle(request, intl)}
      serviceUrl={request.media?.serviceUrl}
    />
  );
};

/**
 * The request as it is now (asked about again while it can be seen and is
 * still on its way), and what can be done to it.
 */
export const useMusicRequest = (request: Request, inView: boolean) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [isApproving, setIsApproving] = useState(false);
  const { data: requestData, mutate: revalidate } = useSWR<Request>(
    `/api/v1/request/${request.id}`,
    {
      fallbackData: request,
      refreshInterval: inView
        ? refreshIntervalHelper<Request>(watchRequest, request)
        : 0,
    }
  );

  const approve = async () => {
    setIsApproving(true);
    try {
      await axios.post(`/api/v1/request/${request.id}/approve`);
      revalidate();
      mutate('/api/v1/request/count');
    } catch {
      addToast(intl.formatMessage(messages.failedmodify), {
        autoDismiss: true,
        appearance: 'error',
      });
    } finally {
      setIsApproving(false);
    }
  };

  const { retry, isRetrying } = useRetryRequest(
    request,
    revalidate,
    messages.failedretry
  );

  const { run } = useRequestAction();
  const remove = () =>
    run(async () => {
      await axios.delete(`/api/v1/request/${request.id}`);
      mutate('/api/v1/request?filter=all&take=10&sort=modified&skip=0');
      mutate('/api/v1/request/count');
    }, messages.failedmodify);

  return {
    requestData: requestData ?? request,
    revalidate,
    approve,
    retry,
    remove,
    isApproving,
    isRetrying,
  };
};
