import AirDateBadge from '@app/components/AirDateBadge';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import StatusBadgeMini from '@app/components/Common/StatusBadgeMini';
import {
  EpisodeSubtitlePanel,
  EpisodeSubtitleTag,
  SeasonMissingBar,
} from '@app/components/Subtitles/EpisodeSubtitles';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import { MediaStatus } from '@server/constants/media';
import type { SeasonWithEpisodes } from '@server/models/Tv';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.TvDetails.Season', {
  somethingwentwrong: 'Something went wrong while retrieving season data.',
  noepisodes: 'Episode list unavailable.',
  request: 'Request',
  requestseason: 'Request Season',
  requested: 'Requested',
  missing:
    '{count, plural, one {# episode is} other {# episodes are}} not in the library yet.',
});

type SeasonProps = {
  seasonNumber: number;
  tvId: number;
  /** Given when the whole season can be requested. */
  onRequestSeason?: () => void;
  /** Given when the user may request; offered per episode that needs it. */
  onRequestEpisode?: (episodeNumber: number) => void;
};

const Season = ({
  seasonNumber,
  tvId,
  onRequestSeason,
  onRequestEpisode,
}: SeasonProps) => {
  const intl = useIntl();
  const { data, error } = useSWR<SeasonWithEpisodes>(
    `/api/v1/tv/${tvId}/season/${seasonNumber}`
  );
  // The episode whose subtitles are open under it.
  const [subtitlesOpen, setSubtitlesOpen] = useState<number | null>(null);

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return <div>{intl.formatMessage(messages.somethingwentwrong)}</div>;
  }

  // Available, or already requested, means there is nothing to ask for.
  const needsRequest = (episode: SeasonWithEpisodes['episodes'][number]) =>
    !episode.available && !episode.requested;
  const missing = data.episodes.filter(needsRequest).length;

  return (
    <div className="flex flex-col justify-center divide-y divide-gray-700">
      <SeasonMissingBar tvId={tvId} seasonNumber={seasonNumber} />
      {onRequestSeason && missing > 0 && (
        <div className="flex flex-col items-start justify-between gap-2 pb-4 sm:flex-row sm:items-center">
          <p className="text-sm text-gray-400">
            {intl.formatMessage(messages.missing, { count: missing })}
          </p>
          <Button
            buttonType="primary"
            buttonSize="sm"
            onClick={onRequestSeason}
          >
            <ArrowDownTrayIcon />
            <span>{intl.formatMessage(messages.requestseason)}</span>
          </Button>
        </div>
      )}
      {data.episodes.length === 0 ? (
        <p>{intl.formatMessage(messages.noepisodes)}</p>
      ) : (
        data.episodes
          .slice()
          .reverse()
          .map((episode) => {
            return (
              <div
                className="py-4"
                key={`season-${seasonNumber}-episode-${episode.episodeNumber}`}
              >
                <div className="flex flex-col space-y-4 xl:flex-row xl:space-x-4 xl:space-y-4">
                  <div className="flex-1">
                    <div className="flex flex-col space-y-2 xl:flex-row xl:items-center xl:space-x-2 xl:space-y-0">
                      <h3 className="text-lg">
                        {episode.episodeNumber} - {episode.name}
                      </h3>
                      {episode.airDate && (
                        <AirDateBadge airDate={episode.airDate} />
                      )}
                      {(episode.available || episode.available4k) && (
                        <div className="flex items-center space-x-2">
                          {episode.available && (
                            <StatusBadgeMini status={MediaStatus.AVAILABLE} />
                          )}
                          {episode.available4k && (
                            <StatusBadgeMini
                              status={MediaStatus.AVAILABLE}
                              is4k
                            />
                          )}
                        </div>
                      )}
                      {episode.requested && !episode.available && (
                        <div className="flex items-center">
                          <Badge badgeType="primary">
                            {intl.formatMessage(messages.requested)}
                          </Badge>
                        </div>
                      )}
                      <EpisodeSubtitleTag
                        tvId={tvId}
                        seasonNumber={seasonNumber}
                        episodeNumber={episode.episodeNumber}
                        open={subtitlesOpen === episode.episodeNumber}
                        onToggle={() =>
                          setSubtitlesOpen(
                            subtitlesOpen === episode.episodeNumber
                              ? null
                              : episode.episodeNumber
                          )
                        }
                      />
                      {onRequestEpisode && needsRequest(episode) && (
                        <div className="flex items-center xl:ml-auto">
                          <Button
                            buttonType="primary"
                            buttonSize="sm"
                            onClick={() =>
                              onRequestEpisode(episode.episodeNumber)
                            }
                          >
                            <ArrowDownTrayIcon />
                            <span>{intl.formatMessage(messages.request)}</span>
                          </Button>
                        </div>
                      )}
                    </div>
                    {episode.overview && <p>{episode.overview}</p>}
                  </div>
                  {episode.stillPath && (
                    <div className="relative aspect-video xl:h-32">
                      <CachedImage
                        type="tmdb"
                        className="rounded-lg object-contain"
                        src={episode.stillPath}
                        alt=""
                        fill
                      />
                    </div>
                  )}
                </div>
                {/* Under the whole episode, still and all. */}
                {subtitlesOpen === episode.episodeNumber && (
                  <EpisodeSubtitlePanel
                    tvId={tvId}
                    seasonNumber={seasonNumber}
                    episodeNumber={episode.episodeNumber}
                    title={episode.name}
                  />
                )}
              </div>
            );
          })
      )}
    </div>
  );
};

export default Season;
