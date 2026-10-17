import Button from '@app/components/Common/Button';
import { useNotice } from '@app/context/NoticeQueue';
import useFeature from '@app/hooks/useFeature';
import type { Passkey } from '@app/hooks/usePasskeys';
import {
  addPasskey,
  isCancelled,
  preloadPasskeys,
  usePasskeySupport,
} from '@app/hooks/usePasskeys';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import {
  SERVER_NAMES,
  accountServers,
  signInServers,
} from '@app/utils/mediaServerAccounts';
import { FingerPrintIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { isAxiosError } from 'axios';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.PasskeyNudge', {
  title: 'Sign in faster with a passkey',
  body: 'Use Face ID, Touch ID or your screen lock next time instead of signing in with {mediaServerName}.',
  bodyPassword:
    'Use Face ID, Touch ID or your screen lock next time instead of your password.',
  add: 'Add a Passkey',
  notNow: 'Not now',
  added: 'Passkey added. Next time, choose Sign in with a passkey.',
  failed: 'The passkey could not be added.',
});

const SNOOZE_DAYS = 14;

// Per person: someone else saying "not now" on this device is not an answer
// for them.
const snoozeKey = (userId: number) => `passkeyNudgeSnoozedAt:${userId}`;

const snoozed = (userId: number): boolean => {
  try {
    const at = Number(localStorage.getItem(snoozeKey(userId)));
    return (
      Number.isFinite(at) && Date.now() - at < SNOOZE_DAYS * 24 * 3600 * 1000
    );
  } catch {
    return false;
  }
};

/**
 * Asks someone signed in without a passkey to add one, on a device that can
 * make one itself. "Not now" asks again in two weeks; adding one, here or in
 * settings, ends it.
 */
const PasskeyNudge = () => {
  const intl = useIntl();
  const { user } = useUser();
  const { currentSettings } = useSettings();
  const { addToast } = useToasts();
  const { onThisDevice } = usePasskeySupport();
  const on = useFeature('passkeyPrompt');
  const router = useRouter();
  // Not on the page where passkeys are added anyway.
  const onPasskeyPage = router.pathname.endsWith('/settings/passkeys');
  const [isSnoozed, setSnoozed] = useState<boolean>();
  const [adding, setAdding] = useState(false);

  const userId = user?.id;
  useEffect(() => {
    setSnoozed(userId ? snoozed(userId) : undefined);
  }, [userId]);

  const { data: passkeys, mutate } = useSWR<Passkey[]>(
    on && user && onThisDevice ? '/api/v1/auth/passkey' : null,
    { revalidateOnFocus: false }
  );

  const state =
    !on || onPasskeyPage || !user || onThisDevice === false || isSnoozed
      ? 'hide'
      : onThisDevice === undefined ||
          isSnoozed === undefined ||
          passkeys === undefined
        ? 'pending'
        : passkeys.length
          ? 'hide'
          : 'show';
  const myTurn = useNotice('passkey', state);
  const showing = myTurn && state === 'show';

  useEffect(() => {
    if (showing) {
      preloadPasskeys();
    }
  }, [showing]);

  const snooze = useCallback(() => {
    if (!userId) {
      return;
    }
    try {
      localStorage.setItem(snoozeKey(userId), String(Date.now()));
    } catch {
      // Snoozed for this visit only.
    }
    setSnoozed(true);
  }, [userId]);

  if (!myTurn) {
    return null;
  }

  // The servers they can sign in with now, by an account of theirs.
  const signInWith = signInServers(currentSettings);
  const signInNames = user
    ? accountServers(user)
        .filter((kind) => signInWith.includes(kind))
        .map((kind) => SERVER_NAMES[kind])
    : [];

  const add = async () => {
    setAdding(true);
    try {
      await addPasskey();
      await mutate();
      addToast(intl.formatMessage(messages.added), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch (e) {
      if (!isCancelled(e)) {
        addToast(
          (isAxiosError(e) && e.response?.data?.message) ||
            intl.formatMessage(messages.failed),
          { appearance: 'error', autoDismiss: true }
        );
      }
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="mb-4 flex w-full items-start gap-3 rounded-md border border-gray-700 bg-gray-800 p-4">
      <FingerPrintIcon className="mt-0.5 h-6 w-6 flex-none text-indigo-300 light:text-accent-text" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-strong">
          {intl.formatMessage(messages.title)}
        </p>
        <p className="mt-1 text-sm text-gray-300">
          {
            // What they sign in with now: their accounts on the connected
            // media servers, or a password of their own here.
            signInNames.length === 0
              ? intl.formatMessage(messages.bodyPassword)
              : intl.formatMessage(messages.body, {
                  mediaServerName: intl.formatList(signInNames, {
                    type: 'disjunction',
                  }),
                })
          }
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            buttonSize="sm"
            buttonType="primary"
            disabled={adding}
            onClick={add}
          >
            {intl.formatMessage(messages.add)}
          </Button>
          <Button buttonSize="sm" disabled={adding} onClick={snooze}>
            {intl.formatMessage(messages.notNow)}
          </Button>
        </div>
      </div>
      <button
        aria-label={intl.formatMessage(messages.notNow)}
        className="text-gray-400 transition duration-150 hover:text-strong"
        onClick={snooze}
        type="button"
      >
        <XMarkIcon className="h-5 w-5" />
      </button>
    </div>
  );
};

export default PasskeyNudge;
