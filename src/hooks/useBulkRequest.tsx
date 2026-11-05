import Button from '@app/components/Common/Button';
import BulkRequestBar from '@app/components/Common/ListView/BulkRequestBar';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import { useSWRConfig } from 'swr';

const messages = defineMessages('components.Common.BulkRequest', {
  select: 'Select',
  done: 'Done',
  unselectable: 'Already requested or in the library',
  requested: 'Requested {count, plural, one {# title} other {# titles}}.',
  alreadyThere:
    '{count, plural, one {# was} other {# were}} already requested or in the library.',
  refused: '{count} not requested: {reason}',
  failed:
    '{count, plural, one {# request} other {# requests}} failed. Try again later.',
});

type Requestable = 'movie' | 'tv';

/** Concurrent requests. */
const REQUEST_CONCURRENCY = 2;

/** Selection key for a title, e.g. "movie:603". */
export const bulkKey = (mediaType: string | undefined, id: number) =>
  `${mediaType ?? ''}:${id}`;

/**
 * Multi-select and bulk request on poster grids (Discover, search,
 * watchlists, credits).
 *
 * The page places `selectButton`, wraps each poster in `pick`, and renders
 * `bar` with the titles it shows.
 */
const useBulkRequest = ({ onDone }: { onDone?: () => void } = {}) => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  const { addToast } = useToasts();
  const { mutate } = useSWRConfig();

  const canRequestMovie = hasPermission(
    [Permission.REQUEST, Permission.REQUEST_MOVIE],
    { type: 'or' }
  );
  const canRequestTv = hasPermission(
    [Permission.REQUEST, Permission.REQUEST_TV],
    { type: 'or' }
  );
  const canSelect = canRequestMovie || canRequestTv;

  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Map<string, Requestable>>(new Map());
  // Just-requested statuses, until the list catches up.
  const [requestedNow, setRequestedNow] = useState<Map<string, MediaStatus>>(
    new Map()
  );
  const [progress, setProgress] = useState<{ done: number; count: number }>();

  /** A title's status, including a request just made here. */
  const statusOf = (key: string, status?: MediaStatus) =>
    requestedNow.get(key) ?? status;

  /** Whether a request could add anything; the server decides finally. */
  const requestable = (
    mediaType: string | undefined,
    status: MediaStatus | undefined
  ): mediaType is Requestable => {
    if (mediaType === 'movie') {
      return (
        canRequestMovie &&
        (!status ||
          status === MediaStatus.UNKNOWN ||
          status === MediaStatus.DELETED)
      );
    }
    if (mediaType === 'tv') {
      return (
        canRequestTv &&
        (!status ||
          status === MediaStatus.UNKNOWN ||
          status === MediaStatus.DELETED ||
          status === MediaStatus.PARTIALLY_AVAILABLE)
      );
    }
    return false;
  };

  const toggle = (key: string, mediaType: Requestable) =>
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.set(key, mediaType);
      }
      return next;
    });

  const stop = () => {
    setSelecting(false);
    setSelected(new Map());
  };

  const requestSelected = async () => {
    const queue = [...selected.entries()];
    const outcome = {
      requested: 0,
      alreadyThere: 0,
      refused: new Map<string, number>(),
      failed: 0,
    };
    const statuses = new Map<string, MediaStatus>();
    let done = 0;
    let next = 0;
    setProgress({ done, count: queue.length });

    await Promise.all(
      Array.from(
        { length: Math.min(REQUEST_CONCURRENCY, queue.length) },
        async () => {
          while (next < queue.length) {
            const [key, mediaType] = queue[next++];
            const mediaId = Number(key.split(':')[1]);
            try {
              const response = await axios.post<{
                status?: MediaRequestStatus;
                message?: string;
              }>(
                '/api/v1/request',
                {
                  mediaType,
                  mediaId,
                  is4k: false,
                  ...(mediaType === 'tv' ? { seasons: 'all' } : {}),
                },
                { validateStatus: () => true }
              );
              if (response.status === 201) {
                outcome.requested++;
                statuses.set(
                  key,
                  response.data.status === MediaRequestStatus.APPROVED
                    ? MediaStatus.PROCESSING
                    : MediaStatus.PENDING
                );
              } else if (response.status === 202 || response.status === 409) {
                outcome.alreadyThere++;
              } else if (response.status === 403) {
                const reason = response.data.message ?? '';
                outcome.refused.set(
                  reason,
                  (outcome.refused.get(reason) ?? 0) + 1
                );
              } else {
                outcome.failed++;
              }
            } catch {
              outcome.failed++;
            }
            done++;
            setProgress({ done, count: queue.length });
          }
        }
      )
    );

    setRequestedNow((current) => new Map([...current, ...statuses]));
    setProgress(undefined);
    stop();

    // Cards that fetch their own status (watchlist) see it next.
    statuses.forEach((_status, key) => {
      const [mediaType, id] = key.split(':');
      mutate(`/api/v1/${mediaType}/${id}`);
    });
    onDone?.();

    if (outcome.requested) {
      addToast(
        intl.formatMessage(messages.requested, { count: outcome.requested }),
        { appearance: 'success', autoDismiss: true }
      );
    }
    if (outcome.alreadyThere) {
      addToast(
        intl.formatMessage(messages.alreadyThere, {
          count: outcome.alreadyThere,
        }),
        { appearance: 'info', autoDismiss: true }
      );
    }
    outcome.refused.forEach((count, reason) =>
      addToast(intl.formatMessage(messages.refused, { count, reason }), {
        appearance: 'warning',
        autoDismiss: false,
      })
    );
    if (outcome.failed) {
      addToast(intl.formatMessage(messages.failed, { count: outcome.failed }), {
        appearance: 'error',
        autoDismiss: false,
      });
    }
  };

  /**
   * Wraps a poster for selection: outlined when chosen, dimmed when not
   * requestable.
   *
   * The outline is on the wrapper so it matches the poster, which is inert
   * while choosing (a tap selects). Positioned so a page backdrop can't sit
   * over it and take the tap.
   *
   * `name` is the screen reader label, since the poster's title only shows on hover.
   */
  const pick = (
    key: string,
    mediaType: string | undefined,
    status: MediaStatus | undefined,
    card: React.ReactNode,
    name: string
  ) => {
    if (!selecting) {
      return card;
    }
    if (!requestable(mediaType, status)) {
      return (
        <div
          title={intl.formatMessage(messages.unselectable)}
          className="relative cursor-not-allowed rounded-xl"
        >
          <div inert className="pointer-events-none opacity-40">
            {card}
          </div>
        </div>
      );
    }
    const isSelected = selected.has(key);
    const choose = () => toggle(key, mediaType);
    return (
      <div
        role="button"
        tabIndex={0}
        aria-pressed={isSelected}
        aria-label={name}
        onClick={choose}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            choose();
          }
        }}
        className={`relative cursor-pointer rounded-xl outline-none ring-offset-2 ring-offset-gray-900 transition ${
          isSelected
            ? 'ring-4 ring-indigo-500'
            : 'focus-visible:ring-2 focus-visible:ring-gray-300'
        }`}
      >
        <div inert className="pointer-events-none">
          {card}
        </div>
      </div>
    );
  };

  const selectButton = canSelect ? (
    <Button
      buttonType={selecting ? 'primary' : 'default'}
      onClick={() => (selecting ? stop() : setSelecting(true))}
      className="flex-none"
    >
      {intl.formatMessage(selecting ? messages.done : messages.select)}
    </Button>
  ) : null;

  /** Bottom bar while choosing. `shown` is [key, media type, status] per visible title, for "Select all shown". */
  const bar = (
    shown: [string, string | undefined, MediaStatus | undefined][]
  ) => {
    if (!selecting) {
      return null;
    }
    const selectable = shown
      .filter(([key, mediaType, status]) =>
        requestable(mediaType, statusOf(key, status))
      )
      .map(([key, mediaType]) => [key, mediaType as Requestable] as const);
    return (
      <BulkRequestBar
        count={selected.size}
        selectable={selectable.length}
        progress={progress}
        onSelectAll={() =>
          setSelected((current) => new Map([...current, ...selectable]))
        }
        onClear={() => setSelected(new Map())}
        onRequest={requestSelected}
      />
    );
  };

  return { selecting, statusOf, pick, selectButton, bar };
};

export default useBulkRequest;
