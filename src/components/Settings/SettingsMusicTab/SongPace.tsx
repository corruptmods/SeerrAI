import defineMessages from '@app/utils/defineMessages';
import { FormattedRelativeTime, useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Settings.SettingsMusicTab', {
  pace: 'How Fast Songs Move',
  paceDescription:
    'The limits songs are held to, so the indexers, MusicBrainz and your download client aren’t flooded, and how much of each is in use now.',
  matching: 'Matching playlist songs',
  matchingLimit:
    '{perPass} at a time, one batch after another, until none are left',
  matchingNow: '{count} waiting',
  matchingRetry:
    'Songs that matched nothing are tried again after {days} days.',
  singles: 'Searching for singles in Lidarr',
  singlesLimit: 'Up to {count} a minute',
  singlesNow:
    'A song whose single Lidarr grabs nothing for is taken from an album.',
  albums: 'Searching albums for songs',
  albumsLimit:
    'The best {open} releases are opened, and up to {packs} discographies when nothing names the album',
  albumsNow: '{searching} searching, {later} waiting to search again',
  albumsNext: 'Next search again {when}',
  albumsAgain:
    'A search that finds nothing waits {hours} hours before the next, then the songs are given up on.',
  downloads: 'Song downloads',
  downloadsLimit:
    '{slots} at once, Backfill’s limit for music downloads (Settings → Backfill)',
  downloadsNow:
    '{downloading} downloading, {waiting} waiting for a slot, {importing} importing',
  soulseek: 'Soulseek',
  soulseekLimit:
    'Up to {songs} songs of an album searched, and {sharers} sharers tried, before Soulseek is passed over',
  soulseekOff: 'Not set up (Settings → Services)',
  limit: 'Limit',
  now: 'Now',
});

interface Pace {
  matching: { perPass: number; waiting: number; unmatchedRetryDays: number };
  singles: { searchesPerMinute: number };
  albums: {
    searching: number;
    waitingToSearchAgain: number;
    nextSearchAt: string | null;
    searchAgainHours: number[];
    releasesOpened: number;
    packsRead: number;
  };
  downloads: {
    slots: number;
    downloading: number;
    waitingForSlot: number;
    importing: number;
  };
  soulseek: { on: boolean; songsSearched: number; sharersTried: number };
}

const Row = ({
  title,
  limit,
  now,
  note,
}: {
  title: string;
  limit: string;
  now?: React.ReactNode;
  note?: string;
}) => {
  const intl = useIntl();
  return (
    <li className="rounded-lg p-4 ring-1 ring-gray-700">
      <div className="font-medium text-strong">{title}</div>
      <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto,1fr]">
        <dt className="text-gray-500">{intl.formatMessage(messages.limit)}</dt>
        <dd className="text-gray-300">{limit}</dd>
        {now !== undefined && (
          <>
            <dt className="text-gray-500">
              {intl.formatMessage(messages.now)}
            </dt>
            <dd className="text-gray-300">{now}</dd>
          </>
        )}
      </dl>
      {note && <p className="mt-2 text-sm text-gray-400">{note}</p>}
    </li>
  );
};

/**
 * Settings → Music: each limit songs are held to, beside how much of it is
 * in use, refreshed while the page is open.
 */
const SongPace = () => {
  const intl = useIntl();
  const { data } = useSWR<Pace>('/api/v1/settings/music/pace', {
    refreshInterval: 30_000,
  });
  if (!data) return null;
  const { matching, singles, albums, downloads, soulseek } = data;
  const next = albums.nextSearchAt
    ? Math.round(
        (new Date(albums.nextSearchAt).getTime() - Date.now()) / 60_000
      )
    : null;

  return (
    <>
      <div className="mb-6 mt-10">
        <h3 className="heading">{intl.formatMessage(messages.pace)}</h3>
        <p className="description">
          {intl.formatMessage(messages.paceDescription)}
        </p>
      </div>
      <ul className="section grid max-w-6xl grid-cols-1 gap-4 lg:grid-cols-2">
        <Row
          title={intl.formatMessage(messages.matching)}
          limit={intl.formatMessage(messages.matchingLimit, {
            perPass: matching.perPass,
          })}
          now={intl.formatMessage(messages.matchingNow, {
            count: matching.waiting,
          })}
          note={intl.formatMessage(messages.matchingRetry, {
            days: matching.unmatchedRetryDays,
          })}
        />
        <Row
          title={intl.formatMessage(messages.singles)}
          limit={intl.formatMessage(messages.singlesLimit, {
            count: singles.searchesPerMinute,
          })}
          note={intl.formatMessage(messages.singlesNow)}
        />
        <Row
          title={intl.formatMessage(messages.albums)}
          limit={intl.formatMessage(messages.albumsLimit, {
            open: albums.releasesOpened,
            packs: albums.packsRead,
          })}
          now={
            <>
              {intl.formatMessage(messages.albumsNow, {
                searching: albums.searching,
                later: albums.waitingToSearchAgain,
              })}
              {next !== null && (
                <span className="block text-gray-400">
                  {intl.formatMessage(messages.albumsNext, {
                    when:
                      next < 60 ? (
                        <FormattedRelativeTime
                          value={Math.max(1, next)}
                          unit="minute"
                        />
                      ) : (
                        <FormattedRelativeTime
                          value={Math.round(next / 60)}
                          unit="hour"
                        />
                      ),
                  })}
                </span>
              )}
            </>
          }
          note={intl.formatMessage(messages.albumsAgain, {
            hours: intl.formatList(albums.searchAgainHours.map(String), {
              type: 'conjunction',
            }),
          })}
        />
        <Row
          title={intl.formatMessage(messages.downloads)}
          limit={intl.formatMessage(messages.downloadsLimit, {
            slots: downloads.slots,
          })}
          now={intl.formatMessage(messages.downloadsNow, {
            downloading: downloads.downloading,
            waiting: downloads.waitingForSlot,
            importing: downloads.importing,
          })}
        />
        <Row
          title={intl.formatMessage(messages.soulseek)}
          limit={
            soulseek.on
              ? intl.formatMessage(messages.soulseekLimit, {
                  songs: soulseek.songsSearched,
                  sharers: soulseek.sharersTried,
                })
              : intl.formatMessage(messages.soulseekOff)
          }
        />
      </ul>
    </>
  );
};

export default SongPace;
