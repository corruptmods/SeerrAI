import type { RequestEta as Eta } from '@app/hooks/useRequestEtas';
import defineMessages from '@app/utils/defineMessages';
import type { IntlShape } from 'react-intl';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.RequestEta', {
  expected: 'Expected',
  cinemas: 'In cinemas {date}',
  digital: 'Digital release expected {date}',
  physical: 'Physical release expected {date}',
  airs: 'Next requested episode airs {date}',
  searchingUnknown: 'Searching',
  releasedDigital: 'Released Digitally',
  releasedPhysical: 'Released Physically',
  releasedCinemas: 'In Cinemas',
  releasedAired: 'Aired',
  releasedUnnamed: 'Released',
  searchingAs: '{released} - Searching',
  searchingAsTypical:
    '{released} - Usually arrives within {days, plural, one {a day} other {# days}} here',
  downloading: 'Downloading',
  waiting: 'Found — waiting briefly in case a better release turns up',
  stalled: 'Downloading — stalled right now',
  details: 'Found — getting the torrent’s details',
  queued: 'Found — waiting its turn to download',
  paused: 'Downloading — paused',
  finishing: 'Downloaded — finishing up',
  importing: 'Downloaded — being added to the library',
  held: 'Held up — waiting on an admin',
  retrying: 'Download failed — looking for another',
  downloadingLeft:
    'Downloading — {minutes, plural, one {about a minute} other {about # min}} left',
  downloadingHours:
    'Downloading — {hours, plural, one {about an hour} other {about # hours}} left',
});

/**
 * A weekday when near, else a date.
 *
 * Film release dates are midnight-UTC calendar dates, shown in UTC so they
 * don't fall a day early west of UTC. Episode air times are instants, shown
 * in local time.
 */
const when = (intl: IntlShape, iso: string, calendarDate: boolean) => {
  const at = new Date(iso);
  const timeZone = calendarDate ? 'UTC' : undefined;
  const days = (at.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
  const year = Number(intl.formatDate(at, { year: 'numeric', timeZone }));
  return days < 6
    ? intl.formatDate(at, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        timeZone,
      })
    : intl.formatDate(at, {
        day: 'numeric',
        month: 'short',
        year: year === new Date().getFullYear() ? undefined : 'numeric',
        timeZone,
      });
};

/**
 * The arrival estimate to show, or null when the status already says it
 * (pending, available) or there is no estimate.
 */
export const describeEta = (
  intl: IntlShape,
  eta: Eta | undefined
): string | null => {
  switch (eta?.stage) {
    case 'unreleased':
      return intl.formatMessage(messages[eta.kind], {
        date: when(intl, eta.date, eta.kind !== 'airs'),
      });
    case 'searching': {
      // Without a known release date it can't be called out.
      if (eta.released === false) {
        return intl.formatMessage(messages.searchingUnknown);
      }
      const names = {
        digital: messages.releasedDigital,
        physical: messages.releasedPhysical,
        cinemas: messages.releasedCinemas,
        aired: messages.releasedAired,
      };
      const released = intl.formatMessage(
        eta.releasedAs ? names[eta.releasedAs] : messages.releasedUnnamed
      );
      return eta.typicalDays
        ? intl.formatMessage(messages.searchingAsTypical, {
            released,
            days: eta.typicalDays,
          })
        : intl.formatMessage(messages.searchingAs, { released });
    }
    case 'downloading':
      if (eta.phase) {
        return intl.formatMessage(messages[eta.phase]);
      }
      if (!eta.minutesLeft) {
        return intl.formatMessage(messages.downloading);
      }
      return eta.minutesLeft >= 90
        ? intl.formatMessage(messages.downloadingHours, {
            hours: Math.round(eta.minutesLeft / 60),
          })
        : intl.formatMessage(messages.downloadingLeft, {
            minutes: eta.minutesLeft,
          });
    default:
      return null;
  }
};

export const expectedLabel = messages.expected;

/** The estimate as a text line, or nothing. */
const RequestEta = ({
  eta,
  className,
}: {
  eta: Eta | undefined;
  className?: string;
}) => {
  const intl = useIntl();
  const text = describeEta(intl, eta);
  return text ? <span className={className}>{text}</span> : null;
};

export default RequestEta;
