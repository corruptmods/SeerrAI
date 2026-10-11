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
  started:
    'Season {season} of {title} and every season after it will be requested as each premieres.',
  paused: 'New Seasons Paused',
  explainPaused:
    'Paused, so nothing is being requested. Tap to stop following this series.',
  stopped: 'You will no longer get new seasons of {title}.',
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

interface FutureSeasonsState {
  following: boolean;
  fromSeason?: number;
}

/**
 * Get a series from here on: every season that has not premiered yet is
 * requested for you as it premieres, and nothing already out.
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
  const allowed = on && canRequest;
  const finished = !!seriesStatus && FINISHED.includes(seriesStatus);

  // Fetched even when following is not allowed right now: someone already
  // following can always stop, whatever has changed since.
  const { data, mutate } = useSWR<FutureSeasonsState>(
    `/api/v1/tv/${tmdbId}/future-seasons`
  );

  if (!data || (!data.following && (!allowed || finished))) {
    return null;
  }
  const paused = data.following && !allowed;

  const toggle = async () => {
    setBusy(true);
    try {
      if (data.following) {
        await axios.delete(`/api/v1/tv/${tmdbId}/future-seasons`);
        await mutate({ following: false }, { revalidate: false });
        addToast(intl.formatMessage(messages.stopped, { title }), {
          appearance: 'info',
          autoDismiss: true,
        });
      } else {
        const response = await axios.post<FutureSeasonsState>(
          `/api/v1/tv/${tmdbId}/future-seasons`
        );
        await mutate(response.data, { revalidate: false });
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

  return (
    <Tooltip
      content={
        paused
          ? intl.formatMessage(messages.explainPaused)
          : data.following
            ? intl.formatMessage(messages.explainOn, {
                season: data.fromSeason,
              })
            : intl.formatMessage(messages.explain)
      }
    >
      <Button
        buttonType={data.following && !paused ? 'success' : 'default'}
        className="z-20"
        disabled={busy}
        onClick={toggle}
        aria-pressed={data.following}
      >
        {data.following ? <CheckIcon /> : <CalendarDaysIcon />}
        <span>
          {intl.formatMessage(
            paused
              ? messages.paused
              : data.following
                ? messages.getting
                : messages.get
          )}
        </span>
      </Button>
    </Tooltip>
  );
};

export default FutureSeasonsButton;
