import Button from '@app/components/Common/Button';
import TitleCard from '@app/components/TitleCard';
import type { ListItem, SeriesProgress } from '@app/hooks/useListDetail';
import defineMessages from '@app/utils/defineMessages';
import { EyeIcon, TrashIcon } from '@heroicons/react/24/outline';
import type { MediaStatus } from '@server/constants/media';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.MediaLists.ListItemCard', {
  watched: 'Watched',
  remove: 'Remove from list',
  episodeprogress: '{available} of {total} episodes',
  upnext: 'Up next S{season} E{episode}',
  tocatchup: '{remaining} to catch up',
  caughtup: 'Caught up',
  notstarted: 'Not started',
});

interface ListItemCardProps {
  item: ListItem;
  /** The viewer's own position, when their watch history can answer it. */
  progress?: SeriesProgress;
  onToggleWatched: (item: ListItem) => void;
  onRemove: (item: ListItem) => void;
}

/**
 * One title on a list: the poster, its watched/remove controls in the card's
 * own action slot, and the episode progress line for a partial series.
 */
const ListItemCard = ({
  item,
  progress,
  onToggleWatched,
  onRemove,
}: ListItemCardProps) => {
  const intl = useIntl();

  return (
    <li key={`item-${item.id}`}>
      <div className={item.watchedAt ? 'opacity-60' : undefined}>
        <TitleCard
          // Fill the grid cell rather than keeping a fixed width: a card
          // narrower than its column leaves ragged gaps down the page. This
          // is how the cast and discover grids do it.
          canExpand
          showListButton={false}
          // The controls go in the card's own action slot, alongside where
          // its request button would sit — so they reveal and scale with the
          // poster as a single element instead of being tracked from outside.
          actionSlot={
            <div className="flex w-full space-x-1">
              <Button
                buttonSize="sm"
                buttonType={item.watchedAt ? 'success' : 'primary'}
                className="h-7 w-full"
                onClick={(e) => {
                  e.preventDefault();
                  onToggleWatched(item);
                }}
              >
                <EyeIcon />
                <span>{intl.formatMessage(messages.watched)}</span>
              </Button>
              <Button
                aria-label={intl.formatMessage(messages.remove)}
                buttonSize="sm"
                buttonType="danger"
                className="h-7 flex-none px-2"
                onClick={(e) => {
                  e.preventDefault();
                  onRemove(item);
                }}
              >
                <TrashIcon />
              </Button>
            </div>
          }
          id={item.tmdbId}
          image={item.posterPath ?? undefined}
          mediaType={item.mediaType}
          status={item.mediaInfo?.status as MediaStatus | undefined}
          summary={undefined}
          title={item.title ?? String(item.tmdbId)}
          year={item.releaseDate}
        />
      </div>
      {/*
        A partially available series shows one status badge, which does not
        say how much of it is actually here. The episode counts come from the
        rows the episode sync already maintains.
      */}
      {item.mediaType === 'tv' &&
        !!item.totalEpisodes &&
        (item.availableEpisodes ?? 0) < item.totalEpisodes && (
          <p className="mt-1 truncate text-xs text-gray-400">
            {intl.formatMessage(messages.episodeprogress, {
              available: item.availableEpisodes ?? 0,
              total: item.totalEpisodes,
            })}
          </p>
        )}
      {progress && (
        <>
          {/*
            Up next and the count to catch up on two short lines: as one
            sentence it did not fit a poster's width and was cut off.
          */}
          <p
            className={
              progress.state === 'up_next'
                ? 'mt-1 truncate text-xs font-medium text-indigo-300'
                : 'mt-1 truncate text-xs text-gray-400'
            }
          >
            {progress.state === 'up_next' && progress.next
              ? intl.formatMessage(messages.upnext, {
                  season: progress.next.season,
                  episode: progress.next.episode,
                })
              : progress.state === 'caught_up'
                ? intl.formatMessage(messages.caughtup)
                : intl.formatMessage(messages.notstarted)}
          </p>
          {progress.state === 'up_next' && progress.next && (
            <p className="truncate text-xs text-gray-400">
              {intl.formatMessage(messages.tocatchup, {
                remaining: progress.remaining,
              })}
            </p>
          )}
        </>
      )}
    </li>
  );
};

export default ListItemCard;
