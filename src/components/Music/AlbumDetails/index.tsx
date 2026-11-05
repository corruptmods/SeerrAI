import BackfillForTitle from '@app/components/Backfill/ForTitle';
import type { LibraryTitle } from '@app/components/Backfill/StartSearchModal';
import BackfillTitleButton from '@app/components/Backfill/TitleButton';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import Tag from '@app/components/Common/Tag';
import MusicImage from '@app/components/Music/MusicImage';
import MusicStatusBadge from '@app/components/Music/MusicStatusBadge';
import MusicUnavailable from '@app/components/Music/MusicUnavailable';
import {
  albumDownloads,
  requestable,
  songDownloads,
  trackLength,
  yearOf,
} from '@app/components/Music/musicHelpers';
import useRequestSong from '@app/components/Music/useRequestSong';
import RequestModal from '@app/components/RequestModal';
import useFeature from '@app/hooks/useFeature';
import usePlayLinks from '@app/hooks/usePlayLinks';
import useSettings from '@app/hooks/useSettings';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import {
  refreshIntervalHelper,
  watchMusic,
} from '@app/utils/refreshIntervalHelper';
import {
  ArrowDownTrayIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  PlayIcon,
} from '@heroicons/react/24/outline';
import { MediaStatus, VARIOUS_ARTISTS_MBID } from '@server/constants/media';
import type { DownloadingItem } from '@server/lib/downloadtracker';
import type { MusicAlbumDetails, MusicTrack } from '@server/models/Music';
import Link from 'next/link';
import { Fragment, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { useSWRConfig } from 'swr';

const messages = defineMessages('components.Music.AlbumDetails', {
  tracks: 'Tracks',
  trackCount: '{count, plural, one {# track} other {# tracks}}',
  disc: 'Disc {number}',
  showTracks: 'Show tracks',
  hideTracks: 'Hide tracks',
  noTracks: 'MusicBrainz has no track list for this album yet.',
  type: 'Type',
  released: 'Released',
  links: 'Links',
  requestAlbum: 'Request Album',
  requestMore: 'Request More',
  requestSong: 'Request Song',
  onlyOnAlbums: 'Only on albums',
  onlyOnAlbumsTip:
    'Not released on its own, so it can’t be requested by itself. Request its album instead.',
  variousArtists:
    'Lidarr cannot add Various Artists, so this compilation cannot be requested.',
  playOn: 'Play on {server}',
});

/**
 * The album's tracks by disc, open by default (foldable on a phone). With
 * song requests on, each requestable track has its own Request (`songsOf`:
 * the artist to request under) and requested ones show their status.
 */
const TrackList = ({
  albumId,
  songsOf,
  downloads,
  follow = 0,
}: {
  albumId: string;
  /** Refresh interval while the album is in progress; 0 for none. */
  follow?: number;
  songsOf?: string;
  /** The artist's downloads; each song's show on its row. */
  downloads?: DownloadingItem[];
}) => {
  const intl = useIntl();
  const { requestSong, isBusy } = useRequestSong();
  const { mutate: mutateAlbum } = useSWRConfig();
  const [open, setChosen] = useState(true);
  // Individually requested songs are followed while in progress; their
  // downloads are the album's, so it refreshes with them.
  const ownFollow = refreshIntervalHelper<{ tracks: MusicTrack[] }>(
    ({ tracks }) =>
      watchMusic({
        downloads: songDownloads(
          downloads,
          tracks.flatMap((track) =>
            track.recordingId ? [track.recordingId] : []
          )
        ),
        onItsWay: tracks.some(
          (track) => track.status === MediaStatus.PROCESSING
        ),
      })
  );
  const { data, error, mutate } = useSWR<{ tracks: MusicTrack[] }>(
    `/api/v1/music/album/${albumId}/tracks`,
    {
      // Refreshes while tracks are being checked, or the album or a song is
      // in progress.
      refreshInterval: (latest) => {
        if (latest?.tracks.some((track) => track.checking)) return 5000;
        const own = ownFollow(latest);
        return own && follow ? Math.min(own, follow) : own || follow;
      },
      onSuccess: (latest) => {
        if (!follow && ownFollow(latest)) {
          mutateAlbum(`/api/v1/music/album/${albumId}`);
        }
      },
    }
  );

  if (error && !data) {
    return <MusicUnavailable error={error} onRetry={() => mutate()} />;
  }

  const tracks = data?.tracks ?? [];
  const discs = [...new Set(tracks.map((track) => track.disc))];
  const total = tracks.reduce((sum, track) => sum + (track.length ?? 0), 0);

  return (
    <section>
      <div className="flex items-baseline justify-between gap-4">
        <h2>{intl.formatMessage(messages.tracks)}</h2>
        {data && tracks.length > 0 && (
          <span className="text-sm text-muted">
            {intl.formatMessage(messages.trackCount, { count: tracks.length })}
            {total > 0 && ` · ${trackLength(total)}`}
          </span>
        )}
      </div>
      {!data ? (
        <LoadingSpinner />
      ) : !tracks.length ? (
        <p>{intl.formatMessage(messages.noTracks)}</p>
      ) : (
        <>
          <button
            type="button"
            className="mt-2 flex items-center gap-1 text-sm text-accent-soft hover:text-indigo-300 light:text-accent-text light:hover:text-accent-text sm:hidden"
            aria-expanded={open}
            onClick={() => setChosen(!open)}
          >
            {open ? (
              <ChevronUpIcon className="h-4 w-4" />
            ) : (
              <ChevronDownIcon className="h-4 w-4" />
            )}
            {intl.formatMessage(
              open ? messages.hideTracks : messages.showTracks
            )}
          </button>
          {open && (
            <ol className="mt-3 divide-y divide-subtle overflow-hidden rounded-lg border border-subtle bg-page">
              {discs.map((disc) => (
                <Fragment key={disc}>
                  {discs.length > 1 && (
                    <li className="bg-surface px-4 py-2 text-sm font-semibold text-default">
                      {tracks.find((t) => t.disc === disc)?.discTitle ||
                        intl.formatMessage(messages.disc, { number: disc })}
                    </li>
                  )}
                  {tracks
                    .filter((track) => track.disc === disc)
                    .map((track) => (
                      <li
                        key={`${disc}-${track.position}`}
                        className="flex items-center gap-3 px-4 py-2 text-sm"
                      >
                        <span className="w-8 shrink-0 text-right tabular-nums text-gray-500">
                          {track.number ?? track.position}
                        </span>
                        <span className="min-w-0 flex-1 break-words text-gray-200">
                          {track.title}
                        </span>
                        <span className="shrink-0 tabular-nums text-muted">
                          {trackLength(track.length)}
                        </span>
                        {/* Fixed width, so lengths line up in every row. */}
                        {!requestable(track.status) ? (
                          <span className="flex w-28 shrink-0 justify-center">
                            <MusicStatusBadge
                              status={track.status}
                              downloads={
                                track.recordingId
                                  ? songDownloads(downloads, [
                                      track.recordingId,
                                    ])
                                  : []
                              }
                              plain
                            />
                          </span>
                        ) : songsOf && track.checking ? (
                          // Request shows once it is known to be on a single.
                          <span className="w-28 shrink-0" />
                        ) : songsOf && track.onlyOnAlbums ? (
                          <span
                            className="w-28 shrink-0 text-center text-xs text-muted"
                            title={intl.formatMessage(messages.onlyOnAlbumsTip)}
                          >
                            {intl.formatMessage(messages.onlyOnAlbums)}
                          </span>
                        ) : songsOf && track.recordingId ? (
                          <Button
                            buttonType="primary"
                            buttonSize="sm"
                            className="h-7 w-28 shrink-0"
                            disabled={isBusy(track.recordingId)}
                            aria-label={`${intl.formatMessage(
                              messages.requestSong
                            )}: ${track.title}`}
                            onClick={() =>
                              requestSong({
                                artistMbid: songsOf,
                                recordingMbid: track.recordingId as string,
                                name: track.title,
                                // The tracks, and the album's status and
                                // downloads.
                                then: () =>
                                  Promise.all([
                                    mutate(),
                                    mutateAlbum(
                                      `/api/v1/music/album/${albumId}`
                                    ),
                                  ]),
                              })
                            }
                          >
                            <ArrowDownTrayIcon />
                            <span>
                              {intl.formatMessage(globalMessages.request)}
                            </span>
                          </Button>
                        ) : (
                          songsOf && <span className="w-28 shrink-0" />
                        )}
                      </li>
                    ))}
                </Fragment>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
};

interface AlbumDetailsProps {
  albumId: string;
}

/** An album's page: cover, artist and tracks. */
const AlbumDetails = ({ albumId }: AlbumDetailsProps) => {
  const intl = useIntl();
  const musicOn = useFeature('music');
  const { currentSettings } = useSettings();
  const { hasPermission } = useUser();
  const [requesting, setRequesting] = useState(false);
  const { mutate: globalMutate } = useSWRConfig();
  // Refreshes while in progress, as a film's page does, so its pill and
  // songs update.
  const watch = (album: MusicAlbumDetails) =>
    watchMusic({
      status: album.status,
      downloads: albumDownloads(album.mediaInfo?.downloadStatus, album.id),
      onItsWay: !!album.addingToLibrary,
    });
  const { data, error, mutate } = useSWR<MusicAlbumDetails>(
    musicOn ? `/api/v1/music/album/${albumId}` : null,
    { refreshInterval: refreshIntervalHelper<MusicAlbumDetails>(watch) }
  );
  // As for films: Plex's app opens on iPhone or iPad; the viewer's own
  // servers come first.
  const albumLinks = useMemo(
    () => (data ? { playLinks: data.playLinks ?? [] } : undefined),
    [data]
  );
  const { links: playLinks } = usePlayLinks(albumLinks);
  // For admins' Backfill: the album in Lidarr, if there.
  const lidarrServer = data?.mediaInfo?.serviceId;
  const { data: inLidarr } = useSWR<LibraryTitle>(
    musicOn &&
      hasPermission(Permission.ADMIN) &&
      data?.mediaInfo?.externalServiceId != null
      ? `/api/v1/backfill/album/${albumId}${
          lidarrServer != null ? `?serverId=${lidarrServer}` : ''
        }`
      : null,
    { shouldRetryOnError: false, revalidateOnFocus: false }
  );

  if (!musicOn) {
    return <ErrorPage statusCode={404} />;
  }
  if (error && !data) {
    return <MusicUnavailable error={error} onRetry={() => mutate()} />;
  }
  if (!data) {
    return <LoadingSpinner />;
  }

  const variousArtists = data.artistId === VARIOUS_ARTISTS_MBID;
  // The album belongs to its first credited artist, as in Lidarr.
  const canRequest =
    !!data.artistId &&
    !variousArtists &&
    requestable(data.status) &&
    hasPermission([Permission.REQUEST, Permission.REQUEST_MUSIC], {
      type: 'or',
    });
  const year = yearOf(data.releaseDate);
  const kind = [data.primaryType, ...data.secondaryTypes]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="media-page">
      <PageTitle
        title={data.artistName ? [data.title, data.artistName] : data.title}
      />
      <div className="media-header">
        <div className="media-poster">
          <div className="relative w-full" style={{ paddingBottom: '100%' }}>
            <MusicImage
              src={data.coverUrl}
              fallback="album"
              priority
              sizes="13rem"
            />
          </div>
        </div>
        <div className="media-title">
          <div className="media-status">
            <MusicStatusBadge
              status={data.status}
              downloads={albumDownloads(
                data.mediaInfo?.downloadStatus,
                data.id
              )}
              addingToLibrary={data.addingToLibrary}
              artistId={data.artistId}
              title={data.artistName}
              serviceUrl={data.mediaInfo?.serviceUrl}
            />
          </div>
          <h1 data-testid="media-title">
            {data.title} {year && <span className="media-year">({year})</span>}
          </h1>
          <span className="media-attributes">
            {data.artists.length > 0 && (
              <span>
                {data.artists.map((artist, i) => (
                  <Fragment key={`${artist.id}-${i}`}>
                    <Link href={`/music/artist/${artist.id}`}>
                      {artist.name}
                    </Link>
                    {artist.joinphrase}
                  </Fragment>
                ))}
              </span>
            )}
            {kind && (
              <>
                <span>|</span>
                <span>{kind}</span>
              </>
            )}
          </span>
        </div>
        <div className="media-actions">
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
          {inLidarr && <BackfillTitleButton id={data.id} target={inLidarr} />}
          {canRequest && (
            <Button buttonType="primary" onClick={() => setRequesting(true)}>
              <ArrowDownTrayIcon />
              <span>
                {intl.formatMessage(
                  // Partly here: request the rest.
                  data.status === MediaStatus.PARTIALLY_AVAILABLE
                    ? messages.requestMore
                    : messages.requestAlbum
                )}
              </span>
            </Button>
          )}
        </div>
      </div>
      {variousArtists && (
        <p className="mt-4 text-sm text-muted">
          {intl.formatMessage(messages.variousArtists)}
        </p>
      )}
      {canRequest && data.artistId && (
        <RequestModal
          type="music"
          show={requesting}
          artistMbid={data.artistId}
          albumMbid={data.id}
          onCancel={() => setRequesting(false)}
          onComplete={() => {
            setRequesting(false);
            mutate();
            // The tracks show the album's status too.
            globalMutate(`/api/v1/music/album/${albumId}/tracks`);
          }}
        />
      )}
      <div className="media-overview">
        <div className="media-overview-left">
          <TrackList
            albumId={data.id}
            follow={refreshIntervalHelper<MusicAlbumDetails>(watch)(data)}
            downloads={data.mediaInfo?.downloadStatus}
            songsOf={
              canRequest && currentSettings.musicSongs
                ? data.artistId
                : undefined
            }
          />
          {data.genres.length > 0 && (
            <div className="mt-6 flex flex-wrap gap-2">
              {data.genres.slice(0, 8).map((genre) => (
                <Tag key={genre}>{genre}</Tag>
              ))}
            </div>
          )}
        </div>
        <div className="media-overview-right">
          {inLidarr && <BackfillForTitle id={data.id} target={inLidarr} />}
          <div className="media-facts">
            {kind && (
              <div className="media-fact">
                <span>{intl.formatMessage(messages.type)}</span>
                <span className="media-fact-value">{kind}</span>
              </div>
            )}
            {data.releaseDate && (
              <div className="media-fact">
                <span>{intl.formatMessage(messages.released)}</span>
                <span className="media-fact-value">{data.releaseDate}</span>
              </div>
            )}
            <div className="media-fact">
              <span>{intl.formatMessage(messages.links)}</span>
              <span className="media-fact-value flex flex-col items-end">
                <a
                  href={`https://musicbrainz.org/release-group/${data.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  MusicBrainz
                </a>
                <a
                  href={`https://listenbrainz.org/album/${data.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  ListenBrainz
                </a>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AlbumDetails;
