import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import PageTitle from '@app/components/Common/PageTitle';
import { NewKey } from '@app/components/UserProfile/UserSettings/UserApiKeySettings';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import {
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  ClipboardDocumentIcon,
  KeyIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import type {
  ApiKeyCreatedResponse,
  SiriKeyResponse,
} from '@server/constants/apiKeys';
import axios, { isAxiosError } from 'axios';
import { useRouter } from 'next/router';
import { Fragment, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useClipboard from 'react-use-clipboard';
import useSWR from 'swr';

const messages = defineMessages(
  'components.UserProfile.UserSettings.UserSiriSettings',
  {
    siri: 'Siri',
    hint: 'Say “Fix this show” or “Fix this movie” to Siri while something is playing. Siri asks what’s wrong and reports it, and the usual fixes start right away. Anything that replaces files is asked about first.',
    othersHint:
      'The key {name}’s Siri shortcut uses to report problems. Revoke it if their phone is lost.',
    step1: '1. Add the shortcut',
    step1Tip:
      'Siri runs it by its name. Call it “Fix this show”, and add it again as “Fix this movie” if you like.',
    addToSiri: 'Add to Siri',
    noShortcut: 'An admin hasn’t shared the shortcut yet.',
    noShortcutAdmin: 'Share it in Settings → Features first.',
    step2: '2. When it asks, give it these',
    address: 'Server address',
    key: 'Siri key',
    keyTip:
      'It can only report problems with what you’re watching. A new key stops the old one working.',
    makeKey: 'Make a Siri Key',
    newKey: 'Make a New Key',
    noKey: 'No Siri key.',
    made: 'Made {date}',
    lastUsed: 'last used {date}',
    neverUsed: 'not used yet',
    revoke: 'Revoke',
    revoked: 'Siri key revoked.',
    changeFailed: 'That did not work. Check your connection and try again.',
    makeFailed: 'The key could not be made.',
    loadFailed: 'This page could not be loaded.',
    newTitle: 'Your Siri Key',
    pasteIt: 'Paste it into the shortcut when it asks for your Siri key.',
    copy: 'Copy',
    copied: 'Copied',
    done: 'Done',
  }
);

/** A value to paste into the shortcut, with a button that copies it. */
const CopyRow = ({ label, value }: { label: string; value: string }) => {
  const intl = useIntl();
  const [copied, copy] = useClipboard(value, { successDuration: 3000 });
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <span className="w-36 flex-none text-sm font-medium text-gray-400">
        {label}
      </span>
      <code className="min-w-0 flex-1 break-all rounded bg-gray-700/60 px-2 py-1.5 font-mono text-sm text-gray-200">
        {value}
      </code>
      <Button
        type="button"
        buttonSize="sm"
        buttonType={copied ? 'success' : 'default'}
        onClick={copy}
        className="flex-none justify-center"
      >
        {copied ? <CheckIcon /> : <ClipboardDocumentIcon />}
        <span aria-live="polite">
          {intl.formatMessage(copied ? messages.copied : messages.copy)}
        </span>
      </Button>
    </div>
  );
};

const UserSiriSettings = () => {
  const intl = useIntl();
  const router = useRouter();
  const { addToast } = useToasts();
  const { user: currentUser, hasPermission } = useUser();
  const { user } = useUser({ id: Number(router.query.userId) });
  const isOwn = !!user && currentUser?.id === user.id;
  const managing = !!user && !isOwn && hasPermission(Permission.MANAGE_USERS);
  const endpoint =
    user && (isOwn || managing)
      ? `/api/v1/user/${user.id}/settings/siri`
      : null;
  const { data, error, mutate } = useSWR<SiriKeyResponse>(endpoint);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<ApiKeyCreatedResponse>();
  const [showing, setShowing] = useState(false);
  // The address this page was opened at, when none is set: known only in
  // the browser.
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);

  const make = async () => {
    if (!user || submitting) return;
    setSubmitting(true);
    try {
      const res = await axios.post<ApiKeyCreatedResponse>(
        `/api/v1/user/${user.id}/settings/siri`
      );
      setCreated(res.data);
      setShowing(true);
      await mutate();
    } catch (e) {
      addToast(
        (isAxiosError(e) && e.response?.data?.message) ||
          intl.formatMessage(messages.makeFailed),
        { appearance: 'error', autoDismiss: true }
      );
    } finally {
      setSubmitting(false);
    }
  };

  const revoke = async () => {
    if (!endpoint) return;
    try {
      await axios.delete(endpoint);
      addToast(intl.formatMessage(messages.revoked), {
        appearance: 'info',
        autoDismiss: true,
      });
    } catch {
      addToast(intl.formatMessage(messages.changeFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    }
    await mutate();
  };

  const date = (value: string) =>
    intl.formatDate(value, { year: 'numeric', month: 'short', day: 'numeric' });
  const address = (data?.applicationUrl || origin).replace(/\/+$/, '');

  const keyRow = data?.key ? (
    <div className="flex flex-wrap items-center gap-4 rounded-lg bg-gray-800/50 px-4 py-4 shadow ring-1 ring-gray-700">
      <KeyIcon
        className="h-6 w-6 flex-none text-indigo-300 light:text-accent-text"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1 text-sm text-gray-400">
        <code className="mr-2 rounded bg-gray-700/60 px-1.5 py-0.5 font-mono text-xs text-gray-200">
          {data.key.prefix}…
        </code>
        {intl.formatMessage(messages.made, { date: date(data.key.createdAt) })}
        {' · '}
        {data.key.lastUsedAt
          ? intl.formatMessage(messages.lastUsed, {
              date: date(data.key.lastUsedAt),
            })
          : intl.formatMessage(messages.neverUsed)}
      </div>
      <div className="flex flex-none gap-2">
        {isOwn && (
          <Button buttonSize="sm" onClick={make} disabled={submitting}>
            <KeyIcon />
            <span>{intl.formatMessage(messages.newKey)}</span>
          </Button>
        )}
        <ConfirmButton
          onClick={revoke}
          confirmText={intl.formatMessage(globalMessages.areyousure)}
        >
          <TrashIcon />
          <span>{intl.formatMessage(messages.revoke)}</span>
        </ConfirmButton>
      </div>
    </div>
  ) : null;

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.siri),
          intl.formatMessage(globalMessages.usersettings),
          user?.displayName,
        ]}
      />
      <div className="mb-6 max-w-2xl">
        <h3 className="heading">{intl.formatMessage(messages.siri)}</h3>
        <p className="description">
          {isOwn
            ? intl.formatMessage(messages.hint)
            : intl.formatMessage(messages.othersHint, {
                name: user?.displayName,
              })}
        </p>
      </div>

      {!data && !error && <LoadingSpinner />}
      {error && !data && (
        <Alert type="error" title={intl.formatMessage(messages.loadFailed)} />
      )}

      {data &&
        !isOwn &&
        (keyRow ?? (
          <p className="text-gray-400">{intl.formatMessage(messages.noKey)}</p>
        ))}

      {data && isOwn && (
        <div className="max-w-3xl space-y-8">
          <section>
            <h4 className="text-lg font-semibold text-strong">
              {intl.formatMessage(messages.step1)}
            </h4>
            <p className="mt-1 text-sm text-gray-400">
              {intl.formatMessage(messages.step1Tip)}
            </p>
            <div className="mt-3">
              {data.shortcutUrl ? (
                <Button
                  as="a"
                  href={data.shortcutUrl}
                  target="_blank"
                  rel="noreferrer"
                  buttonType="primary"
                >
                  <ArrowTopRightOnSquareIcon />
                  <span>{intl.formatMessage(messages.addToSiri)}</span>
                </Button>
              ) : (
                <Alert
                  type="info"
                  title={intl.formatMessage(messages.noShortcut)}
                >
                  {hasPermission(Permission.ADMIN)
                    ? intl.formatMessage(messages.noShortcutAdmin)
                    : undefined}
                </Alert>
              )}
            </div>
          </section>

          <section className="space-y-3">
            <h4 className="text-lg font-semibold text-strong">
              {intl.formatMessage(messages.step2)}
            </h4>
            {address && (
              <CopyRow
                label={intl.formatMessage(messages.address)}
                value={address}
              />
            )}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
              <span className="w-36 flex-none pt-1.5 text-sm font-medium text-gray-400">
                {intl.formatMessage(messages.key)}
              </span>
              <div className="min-w-0 flex-1 space-y-2">
                {keyRow ?? (
                  <Button
                    buttonType="primary"
                    onClick={make}
                    disabled={submitting}
                  >
                    <KeyIcon />
                    <span>{intl.formatMessage(messages.makeKey)}</span>
                  </Button>
                )}
                <p className="text-sm text-gray-400">
                  {intl.formatMessage(messages.keyTip)}
                </p>
              </div>
            </div>
          </section>
        </div>
      )}

      <Transition
        as={Fragment}
        show={showing}
        afterLeave={() => setCreated(undefined)}
        enter="transition-opacity ease-in-out duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity ease-in-out duration-300"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
      >
        <Modal
          title={intl.formatMessage(messages.newTitle)}
          okText={intl.formatMessage(messages.done)}
          onOk={() => setShowing(false)}
          // Shown only this once: Done closes it, not a stray click.
          backgroundClickable={false}
        >
          {created && (
            <NewKey
              secret={created.secret}
              hint={intl.formatMessage(messages.pasteIt)}
            />
          )}
        </Modal>
      </Transition>
    </>
  );
};

export default UserSiriSettings;
