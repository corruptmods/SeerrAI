import Badge from '@app/components/Common/Badge';
import Tooltip from '@app/components/Common/Tooltip';
import MusicStatusBadge from '@app/components/Music/MusicStatusBadge';
import {
  artistImageUrl,
  musicRequestStatus,
} from '@app/components/Music/musicHelpers';
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
 * it links, its picture, its albums, its status, and approving, retrying
 * and removing it. Nothing here asks TMDB: music has no TMDB id.
 */

export const messages = defineMessages('components.Music.MusicRequest', {
  albumCount: '{count, plural, one {# album} other {# albums}}',
  albums: '{count, plural, one {Album} other {Albums}}',
  unknownArtist: 'Unknown Artist',
  failedretry: 'Something went wrong while retrying the request.',
  failedmodify: 'Something went wrong while modifying the request.',
});

type Request = NonFunctionProperties<MediaRequest>;

const albumsOf = (request: Request) =>
  [...(request.albums ?? [])].sort((a, b) => a.id - b.id);

/** "Artist — Album", or "Artist — 3 albums". */
export const musicRequestTitle = (
  request: Request,
  intl: IntlShape
): string => {
  const artist =
    request.media?.foreignTitle || intl.formatMessage(messages.unknownArtist);
  const albums = albumsOf(request);
  return albums.length === 1
    ? `${artist} — ${albums[0].title}`
    : `${artist} — ${intl.formatMessage(messages.albumCount, {
        count: albums.length,
      })}`;
};

/** The album's page for one album, the artist's for several. */
export const musicRequestHref = (request: Request): string => {
  const albums = albumsOf(request);
  return albums.length === 1
    ? `/music/album/${albums[0].albumMbid}`
    : `/music/artist/${request.media?.foreignId}`;
};

/** The album's cover for one album, a picture of the artist otherwise. */
export const musicRequestImage = (request: Request): string | undefined => {
  const albums = albumsOf(request);
  if (albums.length === 1) {
    return albumCoverUrl(albums[0].albumMbid);
  }
  return request.media?.foreignId
    ? artistImageUrl(request.media.foreignId)
    : undefined;
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
                <MusicStatusBadge status={album.albumStatus} />
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
  return status === MediaStatus.UNKNOWN ? null : (
    <MusicStatusBadge status={status} />
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
  const [isRetrying, setIsRetrying] = useState(false);
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

  const retry = async () => {
    setIsRetrying(true);
    try {
      const result = await axios.post<Request>(
        `/api/v1/request/${request.id}/retry`
      );
      revalidate(result.data);
    } catch {
      addToast(intl.formatMessage(messages.failedretry), {
        autoDismiss: true,
        appearance: 'error',
      });
    } finally {
      setIsRetrying(false);
    }
  };

  const remove = async () => {
    await axios.delete(`/api/v1/request/${request.id}`);
    mutate('/api/v1/request?filter=all&take=10&sort=modified&skip=0');
    mutate('/api/v1/request/count');
  };

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
