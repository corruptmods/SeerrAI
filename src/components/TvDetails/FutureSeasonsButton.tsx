import Button from '@app/components/Common/Button';
import Tooltip from '@app/components/Common/Tooltip';
import useFeature from '@app/hooks/useFeature';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { CalendarDaysIcon, CheckIcon } from '@heroicons/react/24/outline';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.TvDetails.FutureSeasonsButton', {
  get: 'Get New Seasons',
  getting: 'Getting New Seasons',
  explain:
    'Request each new season as it premieres, without the seasons already out.',
  explainOn:
    'Season {season} and every one after it are requested as each premieres. Tap to stop.',
  explainOnFor:
    'Season {season} and every one after it are requested as each premieres. {names} {count, plural, one {follows} other {follow}} this series. Tap to stop it for everyone.',
  explainOnShared:
    'Season {season} and every one after it are requested as each premieres. Others follow this series too. Tap to stop yours.',
  explainShared:
    'Season {season} and every one after it are already requested as each premieres, for someone who follows this series.',
  started:
    'Season {season} of {title} and every season after it will be requested as each premieres.',
  paused: 'New Seasons Paused',
  explainPaused:
    'Paused, so nothing is being requested. Tap to stop following this series.',
  stopped: 'You will no longer get new seasons of {title}.',
  stoppedShared:
    'You no longer follow {title}. Its new seasons still come for the others who do.',
  stoppedEveryone:
    'New seasons of {title} will no longer be requested for anyone.',
  failed: 'Something went wrong. Try again.',
});

/** TMDB's statuses for a series that will have no more seasons. */
const FINISHED = ['Ended', 'Canceled'];

interface FutureSeasonsButtonProps {
  tmdbId: number;
  title: string;
  /** TMDB's status for the series. */
  seriesStatus?: string;
}

export interface FutureSeasonsState {
  following: boolean;
  fromSeason?: number;
  /** Someone else follows the series, so its new seasons come anyway. */
  othersFollow?: boolean;
  othersFrom?: number;
  /** Who they are; only told to those who manage requests. */
  others?: string[];
}

/**
 * Get a series from here on: every season that has not premiered yet is
 * requested as it premieres, and nothing already out. Shown on for everyone
 * once anyone follows it, since the seasons come for all; people who manage
 * requests can stop it for everyone.
 */
const FutureSeasonsButton = ({
  tmdbId,
  title,
  seriesStatus,
}: FutureSeasonsButtonProps) => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  const { addToast } = useToasts();
  const [busy, setBusy] = useState(false);

  const on = useFeature('newSeasons');
  const canRequest = hasPermission(
    [Permission.REQUEST, Permission.REQUEST_TV],
    {
      type: 'or',
    }
  );
  const manager = hasPermission(Permission.MANAGE_REQUESTS);
  const allowed = on && canRequest;
  const finished = !!seriesStatus && FINISHED.includes(seriesStatus);

  // Fetched even when following is not allowed right now: someone already
  // following can always stop, whatever has changed since.
  const { data, mutate } = useSWR<FutureSeasonsState>(
    `/api/v1/tv/${tmdbId}/future-seasons`
  );

  if (
    !data ||
    (!data.following && !(on && data.othersFollow) && (!allowed || finished))
  ) {
    return null;
  }
  const mine = data.following;
  const shared = !!data.othersFollow;
  const followed = mine || shared;
  const paused = mine && !allowed && !shared;
  // Someone else's follow is theirs to stop, or a manager's.
  const canToggle = !followed || mine || manager;
  const season = Math.min(
    ...[data.fromSeason, data.othersFrom].filter(
      (n): n is number => n !== undefined
    )
  );
  const others = data.others ?? [];

  const toggle = async () => {
    setBusy(true);
    try {
      if (followed && manager) {
        await axios.delete(`/api/v1/tv/${tmdbId}/future-seasons`, {
          params: { everyone: true },
        });
        await mutate({ following: false }, { revalidate: false });
        addToast(intl.formatMessage(messages.stoppedEveryone, { title }), {
          appearance: 'info',
          autoDismiss: true,
        });
      } else if (mine) {
        await axios.delete(`/api/v1/tv/${tmdbId}/future-seasons`);
        await mutate(
          { ...data, following: false, fromSeason: undefined },
          { revalidate: false }
        );
        addToast(
          intl.formatMessage(
            shared ? messages.stoppedShared : messages.stopped,
            {
              title,
            }
          ),
          { appearance: 'info', autoDismiss: true }
        );
      } else {
        const response = await axios.post<FutureSeasonsState>(
          `/api/v1/tv/${tmdbId}/future-seasons`
        );
        await mutate({ ...data, ...response.data }, { revalidate: false });
        addToast(
          intl.formatMessage(messages.started, {
            season: response.data.fromSeason,
            title,
          }),
          { appearance: 'success', autoDismiss: true }
        );
      }
    } catch {
      addToast(intl.formatMessage(messages.failed), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setBusy(false);
    }
  };

  const tip = paused
    ? intl.formatMessage(messages.explainPaused)
    : !followed
      ? intl.formatMessage(messages.explain)
      : manager && others.length
        ? intl.formatMessage(messages.explainOnFor, {
            season,
            names: intl.formatList(others, { type: 'conjunction' }),
            count: others.length,
          })
        : !mine
          ? intl.formatMessage(messages.explainShared, { season })
          : shared
            ? intl.formatMessage(messages.explainOnShared, { season })
            : intl.formatMessage(messages.explainOn, { season });

  return (
    <Tooltip content={tip}>
      <Button
        buttonType={followed && !paused ? 'success' : 'default'}
        className={`z-20${canToggle ? '' : 'cursor-default'}`}
        disabled={busy}
        onClick={canToggle ? toggle : undefined}
        aria-pressed={followed}
        aria-disabled={!canToggle || undefined}
      >
        {followed ? <CheckIcon /> : <CalendarDaysIcon />}
        <span>
          {intl.formatMessage(
            paused
              ? messages.paused
              : followed
                ? messages.getting
                : messages.get
          )}
        </span>
      </Button>
    </Tooltip>
  );
};

export default FutureSeasonsButton;
