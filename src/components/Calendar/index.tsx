import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import Header from '@app/components/Common/Header';
import PageTitle from '@app/components/Common/PageTitle';
import defineMessages from '@app/utils/defineMessages';
import { FilmIcon, TvIcon } from '@heroicons/react/24/outline';
import type { CalendarItem } from '@server/lib/calendar';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { IntlShape } from 'react-intl';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Calendar', {
  calendar: 'Calendar',
  subtitle: 'Upcoming releases for everything Radarr and Sonarr monitor.',
  all: 'All',
  movies: 'Movies',
  series: 'Series',
  today: 'Today',
  tomorrow: 'Tomorrow',
  cinemas: 'In cinemas',
  digital: 'Digital release',
  physical: 'Physical release',
  episode: 'S{season} E{episode}',
  episodes: 'S{season} E{first}–E{last}',
  episodeCount: 'S{season} · {count} episodes',
  available: 'Available',
  nothing: 'Nothing is due in the next {weeks} weeks.',
  showMore: 'Show the next 4 weeks',
  error: 'Could not load the calendar.',
});

type Filter = 'all' | 'movie' | 'tv';
const PAGE_WEEKS = 4;
const MAX_WEEKS = 12;

/** Midnight at the start of a local day, as a key. */
const localKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/**
 * The day an item falls on for the viewer. A film's release is a calendar
 * date stored at midnight UTC — read in local time west of UTC it would fall
 * a day early — so it keeps its own date. An episode airs at a real moment,
 * so it falls on the viewer's local day.
 */
const dayOf = (item: CalendarItem) =>
  item.allDay ? item.at.slice(0, 10) : localKey(new Date(item.at));

const dayHeading = (intl: IntlShape, key: string, todayKey: string) => {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (key === todayKey) return intl.formatMessage(messages.today);
  if (key === localKey(tomorrow)) return intl.formatMessage(messages.tomorrow);
  return intl.formatDate(date, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
};

const whatIsDue = (intl: IntlShape, item: CalendarItem) => {
  if (item.kind !== 'episode') {
    return intl.formatMessage(messages[item.kind]);
  }
  const episodes = [...(item.episodes ?? [])].sort((a, b) => a - b);
  const consecutive = episodes.every(
    (episode, index) => index === 0 || episode === episodes[index - 1] + 1
  );
  const numbers =
    episodes.length === 1
      ? intl.formatMessage(messages.episode, {
          season: item.season,
          episode: episodes[0],
        })
      : consecutive
        ? intl.formatMessage(messages.episodes, {
            season: item.season,
            first: episodes[0],
            last: episodes[episodes.length - 1],
          })
        : intl.formatMessage(messages.episodeCount, {
            season: item.season,
            count: episodes.length,
          });
  return item.episodeTitle ? `${numbers} · ${item.episodeTitle}` : numbers;
};

const Row = ({ item }: { item: CalendarItem }) => {
  const intl = useIntl();
  const href = item.tmdbId ? `/${item.mediaType}/${item.tmdbId}` : undefined;
  const Icon = item.mediaType === 'movie' ? FilmIcon : TvIcon;

  const content = (
    <div className="flex items-center gap-3 rounded-lg px-2 py-2 transition hover:bg-gray-800/60">
      <div className="relative h-16 w-11 flex-none overflow-hidden rounded-md bg-gray-800">
        {item.poster ? (
          <CachedImage
            type={
              item.poster.startsWith('https://artworks.thetvdb.com')
                ? 'tvdb'
                : 'tmdb'
            }
            src={item.poster}
            alt=""
            fill
            sizes="44px"
            style={{ objectFit: 'cover' }}
          />
        ) : (
          <Icon className="m-auto mt-4 h-6 w-6 text-gray-500" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold text-gray-100">{item.title}</p>
        <p className="truncate text-sm text-gray-400">
          {whatIsDue(intl, item)}
        </p>
      </div>
      <div className="flex flex-none flex-col items-end gap-1 text-xs text-gray-400">
        {!item.allDay && (
          <span>
            {intl.formatTime(new Date(item.at), {
              hour: 'numeric',
              minute: '2-digit',
            })}
          </span>
        )}
        {item.available && (
          <Badge badgeType="success">
            {intl.formatMessage(messages.available)}
          </Badge>
        )}
      </div>
    </div>
  );

  return href ? <Link href={href}>{content}</Link> : content;
};

/**
 * What is coming, day by day: film releases and episode air dates for
 * everything Radarr and Sonarr are watching for.
 */
const Calendar = () => {
  const intl = useIntl();
  const [weeks, setWeeks] = useState(PAGE_WEEKS);
  const [filter, setFilter] = useState<Filter>('all');
  const { data, error } = useSWR<{ items: CalendarItem[] }>(
    `/api/v1/calendar?weeks=${weeks}`,
    { keepPreviousData: true, revalidateOnFocus: false }
  );

  const todayKey = localKey(new Date());
  const days = useMemo(() => {
    const grouped = new Map<string, CalendarItem[]>();
    for (const item of data?.items ?? []) {
      if (filter !== 'all' && item.mediaType !== filter) continue;
      const key = dayOf(item);
      // The server starts a day early to catch releases at midnight UTC;
      // anything before the viewer's own today is past.
      if (key < todayKey) continue;
      grouped.set(key, [...(grouped.get(key) ?? []), item]);
    }
    return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [data, filter, todayKey]);

  const filters: { id: Filter; label: string }[] = [
    { id: 'all', label: intl.formatMessage(messages.all) },
    { id: 'movie', label: intl.formatMessage(messages.movies) },
    { id: 'tv', label: intl.formatMessage(messages.series) },
  ];

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.calendar)} />
      <div className="mb-2">
        <Header subtext={intl.formatMessage(messages.subtitle)}>
          {intl.formatMessage(messages.calendar)}
        </Header>
      </div>

      <div className="mb-6 flex gap-2">
        {filters.map(({ id, label }) => (
          <Button
            key={`calendar-filter-${id}`}
            buttonType={filter === id ? 'primary' : 'default'}
            buttonSize="sm"
            onClick={() => setFilter(id)}
          >
            {label}
          </Button>
        ))}
      </div>

      {error && !data ? (
        <p className="text-gray-400">{intl.formatMessage(messages.error)}</p>
      ) : !data ? (
        <div aria-busy="true" className="max-w-3xl space-y-3">
          {Array.from({ length: 6 }, (_, i) => (
            <div
              key={`calendar-skeleton-${i}`}
              className="h-20 w-full animate-pulse rounded-lg bg-gray-800"
            />
          ))}
        </div>
      ) : (
        <div className="max-w-3xl xl:max-w-none">
          {days.length === 0 ? (
            <p className="text-gray-400">
              {intl.formatMessage(messages.nothing, { weeks })}
            </p>
          ) : (
            // One column on a phone; on a wide screen, each day is a card, two
            // or three across, instead of a narrow list down one side.
            <div className="xl:grid xl:grid-cols-2 xl:items-start xl:gap-6 2xl:grid-cols-3">
              {days.map(([key, items]) => (
                <section
                  key={`calendar-day-${key}`}
                  className="mb-6 xl:mb-0 xl:rounded-xl xl:border xl:border-gray-800 xl:bg-gray-800/30 xl:p-3 light:xl:border-subtle"
                >
                  <h2
                    className={`mb-1 px-2 text-sm font-bold uppercase tracking-wider ${
                      key === todayKey ? 'text-indigo-400' : 'text-gray-400'
                    }`}
                  >
                    {dayHeading(intl, key, todayKey)}
                  </h2>
                  <div className="divide-y divide-gray-800 light:divide-subtle">
                    {items.map((item) => (
                      <Row
                        key={`${item.mediaType}-${item.tmdbId ?? item.title}-${item.kind}-${item.at}`}
                        item={item}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
          {weeks < MAX_WEEKS && (
            <Button
              buttonType="ghost"
              className="mt-2 w-full sm:w-auto xl:mt-6"
              onClick={() => setWeeks(Math.min(MAX_WEEKS, weeks + PAGE_WEEKS))}
            >
              {intl.formatMessage(messages.showMore)}
            </Button>
          )}
        </div>
      )}
    </>
  );
};

export default Calendar;
