import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import Tag from '@app/components/Common/Tag';
import MusicImage from '@app/components/Music/MusicImage';
import MusicStatusBadge from '@app/components/Music/MusicStatusBadge';
import MusicUnavailable from '@app/components/Music/MusicUnavailable';
import { trackLength, yearOf } from '@app/components/Music/musicHelpers';
import useFeature from '@app/hooks/useFeature';
import useMediaQuery from '@app/hooks/useMediaQuery';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/24/outline';
import type { MusicAlbumDetails, MusicTrack } from '@server/models/Music';
import Link from 'next/link';
import { Fragment, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

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
});

/** The album's tracks, disc by disc; folded away on a phone at first. */
const TrackList = ({ albumId }: { albumId: string }) => {
  const intl = useIntl();
  const wide = useMediaQuery('(min-width: 640px)');
  // Until someone opens or closes it, it follows the screen.
  const [chosen, setChosen] = useState<boolean>();
  const open = chosen ?? wide;
  const { data, error, mutate } = useSWR<{ tracks: MusicTrack[] }>(
    `/api/v1/music/album/${albumId}/tracks`
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
          <span className="text-sm text-gray-400">
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
            className="mt-2 flex items-center gap-1 text-sm text-indigo-400 hover:text-indigo-300 sm:hidden"
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
            <ol className="mt-3 divide-y divide-gray-700 overflow-hidden rounded-lg border border-gray-700 bg-gray-900">
              {discs.map((disc) => (
                <Fragment key={disc}>
                  {discs.length > 1 && (
                    <li className="bg-gray-800 px-4 py-2 text-sm font-semibold text-gray-300">
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
                        <span className="min-w-0 flex-1 truncate text-gray-200">
                          {track.title}
                        </span>
                        <span className="shrink-0 tabular-nums text-gray-400">
                          {trackLength(track.length)}
                        </span>
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

/** An album's page: its cover, who made it, and its tracks. */
const AlbumDetails = ({ albumId }: AlbumDetailsProps) => {
  const intl = useIntl();
  const musicOn = useFeature('music');
  const { data, error, mutate } = useSWR<MusicAlbumDetails>(
    musicOn ? `/api/v1/music/album/${albumId}` : null
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
            <MusicStatusBadge status={data.status} />
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
      </div>
      <div className="media-overview">
        <div className="media-overview-left">
          <TrackList albumId={data.id} />
          {data.genres.length > 0 && (
            <div className="mt-6 flex flex-wrap gap-2">
              {data.genres.slice(0, 8).map((genre) => (
                <Tag key={genre}>{genre}</Tag>
              ))}
            </div>
          )}
        </div>
        <div className="media-overview-right">
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
