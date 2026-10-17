import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import Tag from '@app/components/Common/Tag';
import Tooltip from '@app/components/Common/Tooltip';
import MusicCard from '@app/components/Music/MusicCard';
import MusicImage from '@app/components/Music/MusicImage';
import MusicManage from '@app/components/Music/MusicManage';
import MusicStatusBadge from '@app/components/Music/MusicStatusBadge';
import MusicUnavailable from '@app/components/Music/MusicUnavailable';
import type { AlbumGroup } from '@app/components/Music/musicHelpers';
import {
  ALBUM_GROUPS,
  albumGroup,
  artistImageUrl,
  byNewest,
  yearOf,
} from '@app/components/Music/musicHelpers';
import RequestModal from '@app/components/RequestModal';
import useFeature from '@app/hooks/useFeature';
import usePlayLinks from '@app/hooks/usePlayLinks';
import { Permission, useUser } from '@app/hooks/useUser';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowDownTrayIcon,
  ArrowTopRightOnSquareIcon,
  CogIcon,
  PlayIcon,
} from '@heroicons/react/24/outline';
import { VARIOUS_ARTISTS_MBID } from '@server/constants/media';
import type { DownloadingItem } from '@server/lib/downloadtracker';
import type {
  MusicAlbumResult,
  MusicArtistDetails,
  MusicPage,
} from '@server/models/Music';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';
import useSWRInfinite from 'swr/infinite';

const messages = defineMessages('components.Music.ArtistDetails', {
  biography: 'Biography',
  readMore: 'Read More',
  readLess: 'Read Less',
  albums: 'Albums',
  eps: 'EPs',
  singles: 'Singles',
  other: 'Other Releases',
  otherTip: 'Live albums, compilations, soundtracks, remixes and the rest',
  showOther:
    'Show {count, plural, one {# other release} other {# other releases}}',
  hideOther: 'Hide other releases',
  showMore: 'Show More',
  noReleases: 'MusicBrainz lists no releases for this artist.',
  type: 'Type',
  from: 'From',
  active: 'Active',
  activeSince: '{begin} to now',
  activeBetween: '{begin} to {end}',
  links: 'Links',
  playOn: 'Play on {server}',
  request: 'Request',
  variousArtists:
    'Lidarr cannot add Various Artists, so their compilations cannot be requested.',
  openInLidarr: 'Open in Lidarr',
  manageArtist: 'Manage Artist',
});

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/** MusicBrainz's link kinds, as people know the sites. */
const linkName = (kind: string, url: string): string => {
  switch (kind) {
    case 'wikipedia':
      return 'Wikipedia';
    case 'wikidata':
      return 'Wikidata';
    case 'bandcamp':
      return 'Bandcamp';
    case 'soundcloud':
      return 'SoundCloud';
    case 'youtube':
      return 'YouTube';
    default:
      return hostOf(url);
  }
};

interface DiscographyProps {
  artistId: string;
  /** What Lidarr is downloading of theirs, for the album cards. */
  downloads?: DownloadingItem[];
  /** Changes when something was requested, to show it. */
  refreshToken: number;
  /** Told when an album was requested from its card. */
  onRequested: () => void;
}

/** The artist's releases, a hundred at a time, grouped by kind. */
const Discography = ({
  artistId,
  downloads,
  refreshToken,
  onRequested,
}: DiscographyProps) => {
  const intl = useIntl();
  const [showOther, setShowOther] = useState(false);
  const { data, error, size, setSize, isValidating, mutate } = useSWRInfinite<
    MusicPage<MusicAlbumResult>
  >((index, previous: MusicPage<MusicAlbumResult> | null) =>
    previous && index + 1 > previous.totalPages
      ? null
      : `/api/v1/music/artist/${artistId}/albums?page=${index + 1}`
  );

  useEffect(() => {
    if (refreshToken) {
      mutate();
    }
  }, [refreshToken, mutate]);

  if (error && !data) {
    return <MusicUnavailable error={error} onRetry={() => setSize(size)} />;
  }
  if (!data) {
    return <LoadingSpinner />;
  }

  const albums = data.flatMap((page) => page.results ?? []).sort(byNewest);
  const more = size < (data[data.length - 1]?.totalPages ?? 1);
  const groups = Object.fromEntries(
    ALBUM_GROUPS.map((group) => [
      group,
      albums.filter((album) => albumGroup(album) === group),
    ])
  ) as Record<AlbumGroup, MusicAlbumResult[]>;

  if (!albums.length) {
    return (
      <p className="mt-8 text-muted">
        {intl.formatMessage(messages.noReleases)}
      </p>
    );
  }

  const grid = (list: MusicAlbumResult[]) => (
    <ul className="cards-vertical mt-4">
      {list.map((album) => (
        <li key={album.id}>
          <MusicCard
            album={album}
            canExpand
            showArtist={false}
            artistId={artistId}
            onRequested={onRequested}
            downloads={downloads}
          />
        </li>
      ))}
    </ul>
  );

  return (
    <div className="mt-4">
      {(['albums', 'eps', 'singles'] as const).map(
        (group) =>
          groups[group].length > 0 && (
            <section key={group} className="mt-8">
              <h2 className="text-xl font-bold text-default sm:text-2xl">
                {intl.formatMessage(messages[group])}
              </h2>
              {grid(groups[group])}
            </section>
          )
      )}
      {groups.other.length > 0 && (
        <section className="mt-8">
          <h2 className="text-xl font-bold text-default sm:text-2xl">
            {intl.formatMessage(messages.other)}
          </h2>
          <p className="text-sm text-muted">
            {intl.formatMessage(messages.otherTip)}
          </p>
          <Button
            buttonType="ghost"
            buttonSize="sm"
            className="mt-3"
            aria-expanded={showOther}
            onClick={() => setShowOther(!showOther)}
          >
            {showOther
              ? intl.formatMessage(messages.hideOther)
              : intl.formatMessage(messages.showOther, {
                  count: groups.other.length,
                })}
          </Button>
          {showOther && grid(groups.other)}
        </section>
      )}
      {more && (
        <div className="mt-8 flex justify-center">
          <Button
            buttonType="primary"
            disabled={isValidating}
            onClick={() => setSize(size + 1)}
          >
            {intl.formatMessage(messages.showMore)}
          </Button>
        </div>
      )}
    </div>
  );
};

interface ArtistDetailsProps {
  artistId: string;
}

/**
 * An artist's page: who they are, from MusicBrainz, and every release they
 * have, grouped as their albums, EPs, singles and the rest.
 */
const ArtistDetails = ({ artistId }: ArtistDetailsProps) => {
  const intl = useIntl();
  const musicOn = useFeature('music');
  const { hasPermission } = useUser();
  const [bioOpen, setBioOpen] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [requested, setRequested] = useState(0);
  const [managing, setManaging] = useState(false);
  const router = useRouter();
  const { data, error, mutate } = useSWR<MusicArtistDetails>(
    musicOn ? `/api/v1/music/artist/${artistId}` : null
  );
  // Played the way a movie or series is: on an iPhone or iPad, Plex's app
  // opens; the viewer's own servers come first.
  const { links: playLinks } = usePlayLinks(data?.mediaInfo);

  // Opened from a status pill's "Manage Artist" link.
  useEffect(() => {
    if (router.query.manage === '1') {
      setManaging(true);
      router.replace({
        pathname: router.pathname,
        query: { mbid: router.query.mbid },
      });
    }
  }, [router, router.query.manage]);
  const variousArtists = artistId === VARIOUS_ARTISTS_MBID;
  const canRequest =
    !variousArtists &&
    hasPermission([Permission.REQUEST, Permission.REQUEST_MUSIC], {
      type: 'or',
    });

  if (!musicOn) {
    return <ErrorPage statusCode={404} />;
  }
  if (error && !data) {
    return <MusicUnavailable error={error} onRetry={() => mutate()} />;
  }
  if (!data) {
    return <LoadingSpinner />;
  }

  const begin = yearOf(data.beginDate);
  const end = yearOf(data.endDate);
  const active =
    begin &&
    (data.ended && end
      ? intl.formatMessage(messages.activeBetween, { begin, end })
      : data.ended
        ? begin
        : intl.formatMessage(messages.activeSince, { begin }));
  const from = data.area ?? data.country;
  const attributes = [data.type, from, active].filter(
    (value): value is string => !!value
  );

  const links = [
    {
      name: 'MusicBrainz',
      url: `https://musicbrainz.org/artist/${data.id}`,
    },
    {
      name: 'ListenBrainz',
      url: `https://listenbrainz.org/artist/${data.id}`,
    },
    ...data.links.map((link) => ({
      name: linkName(link.kind, link.url),
      url: link.url,
    })),
  ];

  return (
    <div className="media-page" style={{ height: 493 }}>
      <div className="media-page-bg-image">
        <MusicImage
          src={artistImageUrl(data.id, 'backdrop')}
          fallback="none"
          priority
        />
        <div className="media-page-fade" />
      </div>
      <PageTitle title={data.name} />
      <div className="media-header">
        <div className="media-poster">
          <div
            className="relative w-full overflow-hidden rounded-full"
            style={{ paddingBottom: '100%' }}
          >
            <MusicImage
              src={artistImageUrl(data.id)}
              fallback="artist"
              priority
              sizes="13rem"
            />
          </div>
        </div>
        <div className="media-title">
          <div className="media-status">
            <MusicStatusBadge
              status={data.mediaInfo?.status}
              downloads={data.mediaInfo?.downloadStatus}
              artistId={data.id}
              title={data.name}
              serviceUrl={data.mediaInfo?.serviceUrl}
            />
          </div>
          <h1 data-testid="media-title">
            {data.name}{' '}
            {data.disambiguation && (
              <span className="media-year">({data.disambiguation})</span>
            )}
          </h1>
          <span className="media-attributes">
            {attributes
              .map((value, k) => <span key={k}>{value}</span>)
              .reduce<
                React.ReactNode[]
              >((all, item, k) => (k ? [...all, <span key={`sep-${k}`}>|</span>, item] : [item]), [])}
          </span>
        </div>
        <div className="media-actions">
          {canRequest && (
            <Button
              buttonType="primary"
              onClick={() => setRequesting(true)}
              className="mb-2 sm:mb-0"
            >
              <ArrowDownTrayIcon />
              <span>{intl.formatMessage(messages.request)}</span>
            </Button>
          )}
          {playLinks
            .filter((link) => link.url)
            .map((link) => (
              <Button
                key={link.server}
                as="a"
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                buttonType="ghost"
              >
                <PlayIcon />
                <span>
                  {intl.formatMessage(messages.playOn, { server: link.name })}
                </span>
              </Button>
            ))}
          {data.mediaInfo && hasPermission(Permission.MANAGE_REQUESTS) && (
            <Tooltip content={intl.formatMessage(messages.manageArtist)}>
              <Button
                buttonType="ghost"
                onClick={() => setManaging(true)}
                className="media-action-icon"
                aria-label={intl.formatMessage(messages.manageArtist)}
              >
                <CogIcon className="!mr-0" />
              </Button>
            </Tooltip>
          )}
          {data.mediaInfo?.serviceUrl && hasPermission(Permission.ADMIN) && (
            <Button
              as="a"
              href={data.mediaInfo.serviceUrl}
              target="_blank"
              rel="noopener noreferrer"
              buttonType="ghost"
            >
              <ArrowTopRightOnSquareIcon />
              <span>{intl.formatMessage(messages.openInLidarr)}</span>
            </Button>
          )}
        </div>
      </div>
      <div className="media-overview">
        <div className="media-overview-left">
          {data.biography && (
            <>
              <h2>{intl.formatMessage(messages.biography)}</h2>
              <p
                className={`whitespace-pre-line ${
                  bioOpen ? '' : 'line-clamp-6'
                }`}
              >
                {data.biography}
              </p>
              <button
                type="button"
                className="mt-2 text-sm text-accent-soft hover:text-indigo-300 light:text-accent-text light:hover:text-accent-text"
                aria-expanded={bioOpen}
                onClick={() => setBioOpen(!bioOpen)}
              >
                {intl.formatMessage(
                  bioOpen ? messages.readLess : messages.readMore
                )}
              </button>
            </>
          )}
          {data.genres.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {data.genres.slice(0, 8).map((genre) => (
                <Tag key={genre}>{genre}</Tag>
              ))}
            </div>
          )}
        </div>
        <div className="media-overview-right">
          <div className="media-facts">
            {data.type && (
              <div className="media-fact">
                <span>{intl.formatMessage(messages.type)}</span>
                <span className="media-fact-value">{data.type}</span>
              </div>
            )}
            {from && (
              <div className="media-fact">
                <span>{intl.formatMessage(messages.from)}</span>
                <span className="media-fact-value">{from}</span>
              </div>
            )}
            {active && (
              <div className="media-fact">
                <span>{intl.formatMessage(messages.active)}</span>
                <span className="media-fact-value">{active}</span>
              </div>
            )}
            <div className="media-fact">
              <span>{intl.formatMessage(messages.links)}</span>
              <span className="media-fact-value flex flex-col items-end">
                {links.map((link) => (
                  <a
                    key={link.url}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {link.name}
                  </a>
                ))}
              </span>
            </div>
          </div>
        </div>
      </div>
      {variousArtists && (
        <p className="mt-4 text-sm text-muted">
          {intl.formatMessage(messages.variousArtists)}
        </p>
      )}
      <Discography
        artistId={data.id}
        downloads={data.mediaInfo?.downloadStatus}
        refreshToken={requested}
        // The artist's status may change with an album asked for.
        onRequested={() => mutate()}
      />
      {data.mediaInfo && hasPermission(Permission.MANAGE_REQUESTS) && (
        <MusicManage
          show={managing}
          artist={data}
          onClose={() => setManaging(false)}
          revalidate={() => {
            mutate();
            setRequested((count) => count + 1);
          }}
        />
      )}
      {canRequest && (
        <RequestModal
          type="music"
          show={requesting}
          artistMbid={data.id}
          onCancel={() => setRequesting(false)}
          onComplete={() => {
            setRequesting(false);
            setRequested((count) => count + 1);
            mutate();
          }}
        />
      )}
    </div>
  );
};

export default ArtistDetails;
