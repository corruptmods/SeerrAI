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
  /** The viewer's progress, when watch history has it. */
  progress?: SeriesProgress;
  onToggleWatched: (item: ListItem) => void;
  onRemove: (item: ListItem) => void;
}

/** A list title: poster, watched/remove controls, and episode progress. */
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
          // Fill the grid cell, as the cast and discover grids do: a fixed
          // width leaves ragged gaps.
          canExpand
          showListButton={false}
          // In the card's action slot, so they reveal and scale with the
          // poster.
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
        A partial series' badge doesn't say how much is here. Counts come
        from the episode sync's rows.
      */}
      {item.mediaType === 'tv' &&
        !!item.totalEpisodes &&
        (item.availableEpisodes ?? 0) < item.totalEpisodes && (
          <p className="mt-1 break-words text-xs text-muted">
            {intl.formatMessage(messages.episodeprogress, {
              available: item.availableEpisodes ?? 0,
              total: item.totalEpisodes,
            })}
          </p>
        )}
      {progress && (
        <>
          {/* Two short lines: one sentence doesn't fit a poster's width. */}
          <p
            className={
              progress.state === 'up_next'
                ? 'mt-1 break-words text-xs font-medium text-indigo-300 light:text-accent-text'
                : 'mt-1 break-words text-xs text-muted'
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
            <p className="break-words text-xs text-muted">
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
