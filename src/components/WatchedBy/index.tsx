import useFeature from '@app/hooks/useFeature';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import type { WatchedBy as Person } from '@server/lib/watchedBy';
import { useState } from 'react';
import { FormattedRelativeTime, useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.WatchedBy', {
  watchedBy: 'Watched by',
  nobody: 'No one yet',
  plays: '{count, plural, one {# play} other {# plays}}',
  episodes: '{count, plural, one {# episode} other {# episodes}}',
  showAll: 'and {count} more',
});

const SHOWN = 4;

/**
 * How long ago, in the unit a person would use: "yesterday", "3 weeks ago",
 * "7 months ago" — not "200 days ago".
 */
const sinceLastWatched = (
  iso: string
): {
  value: number;
  unit: 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';
} => {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const minutes = seconds / 60;
  const hours = minutes / 60;
  const days = hours / 24;
  if (Math.abs(hours) < 1)
    return { value: Math.round(minutes), unit: 'minute' };
  if (Math.abs(days) < 1) return { value: Math.round(hours), unit: 'hour' };
  if (Math.abs(days) < 7) return { value: Math.round(days), unit: 'day' };
  if (Math.abs(days) < 30) return { value: Math.round(days / 7), unit: 'week' };
  if (Math.abs(days) < 365)
    return { value: Math.round(days / 30), unit: 'month' };
  return { value: Math.round(days / 365), unit: 'year' };
};

/**
 * Who has watched this title and when last, from Tautulli, as a row in the
 * title's facts. Admins only, like the watch data behind the manage panel.
 * Nothing when Tautulli is not set up.
 */
const WatchedBy = ({
  mediaId,
  isShow,
}: {
  mediaId?: number;
  isShow: boolean;
}) => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  const [expanded, setExpanded] = useState(false);
  const on = useFeature('whoWatched');
  const { data } = useSWR<{ configured: boolean; people: Person[] }>(
    on && mediaId && hasPermission(Permission.ADMIN)
      ? `/api/v1/media/${mediaId}/watched-by`
      : null,
    { revalidateOnFocus: false }
  );

  if (!data?.configured) {
    return null;
  }

  const shown = expanded ? data.people : data.people.slice(0, SHOWN);

  return (
    <div className="media-fact">
      <span>{intl.formatMessage(messages.watchedBy)}</span>
      <span className="media-fact-value">
        {data.people.length === 0
          ? intl.formatMessage(messages.nobody)
          : shown.map((person) => {
              const { value, unit } = sinceLastWatched(person.lastWatched);
              return (
                <span
                  key={`watched-by-${person.user?.id ?? person.name}`}
                  className="mb-1 block last:mb-0"
                >
                  <span className="block text-gray-200">{person.name}</span>
                  <span className="block text-xs text-gray-400">
                    {person.count > 1 || isShow
                      ? `${intl.formatMessage(
                          isShow ? messages.episodes : messages.plays,
                          { count: person.count }
                        )} · `
                      : ''}
                    <FormattedRelativeTime
                      value={value}
                      unit={unit}
                      numeric="auto"
                    />
                  </span>
                </span>
              );
            })}
        {!expanded && data.people.length > SHOWN && (
          <button
            type="button"
            className="block text-indigo-400 hover:text-indigo-300"
            onClick={() => setExpanded(true)}
          >
            {intl.formatMessage(messages.showAll, {
              count: data.people.length - SHOWN,
            })}
          </button>
        )}
      </span>
    </div>
  );
};

export default WatchedBy;
