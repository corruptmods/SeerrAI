import PushOptInContent from '@app/components/PushOptIn/PushOptInContent';
import { useNotice } from '@app/context/NoticeQueue';
import usePushDeviceState from '@app/hooks/usePushDeviceState';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { useCallback, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

const DISMISS_DAYS = 7;

// Per person: a dismissal by someone else on this device is not theirs.
const dismissKey = (userId: number) => `pushOptInDismissedAt:${userId}`;

const messages = defineMessages('components.PushOptIn', {
  dismiss: 'Dismiss',
});

const isDismissed = (userId: number): boolean => {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(dismissKey(userId));
  } catch {
    // Storage unavailable (private browsing): ask, as nothing was saved.
  }

  if (!raw) {
    return false;
  }

  const dismissedAt = Number(raw);

  if (!Number.isFinite(dismissedAt)) {
    return false;
  }

  return Date.now() - dismissedAt < DISMISS_DAYS * 24 * 60 * 60 * 1000;
};

const PushOptInBanner = () => {
  const intl = useIntl();
  const { user } = useUser();
  const { state, subscribe } = usePushDeviceState();
  // Unknown until storage is read after mounting.
  const [dismissed, setDismissed] = useState<boolean>();
  const [isSubscribing, setSubscribing] = useState(false);

  const userId = user?.id;
  useEffect(() => {
    setDismissed(userId ? isDismissed(userId) : undefined);
  }, [userId]);

  const handleDismiss = useCallback(() => {
    if (!userId) {
      return;
    }
    try {
      localStorage.setItem(dismissKey(userId), String(Date.now()));
    } catch {
      // Dismissed for this visit only.
    }
    setDismissed(true);
  }, [userId]);

  const handleEnable = useCallback(async () => {
    setSubscribing(true);
    await subscribe();
    setSubscribing(false);
  }, [subscribe]);

  const nothingToAsk =
    dismissed ||
    state === 'registered' ||
    state === 'disabled' ||
    state === 'unsupported';
  const myTurn = useNotice(
    'pushOptIn',
    !userId
      ? 'hide'
      : state === 'loading' || dismissed === undefined
        ? 'pending'
        : nothingToAsk
          ? 'hide'
          : 'show'
  );

  if (!myTurn) {
    return null;
  }

  return (
    <div className="mb-4 flex w-full items-start space-x-3 rounded-md border border-gray-700 bg-gray-800 p-4">
      <div className="min-w-0 flex-1">
        <PushOptInContent
          state={state}
          isSubscribing={isSubscribing}
          onEnable={handleEnable}
        />
      </div>
      <button
        aria-label={intl.formatMessage(messages.dismiss)}
        className="text-gray-400 transition duration-150 hover:text-white"
        onClick={handleDismiss}
        type="button"
      >
        <XMarkIcon className="h-5 w-5" />
      </button>
    </div>
  );
};

export default PushOptInBanner;
