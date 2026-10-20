import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import PageTitle from '@app/components/Common/PageTitle';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import {
  CheckIcon,
  ClipboardDocumentIcon,
  KeyIcon,
  PlusIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import type {
  ApiKeyCreatedResponse,
  ApiKeyLifetime,
  ApiKeyListResponse,
  ApiKeySummary,
} from '@server/constants/apiKeys';
import {
  API_KEY_LIFETIMES,
  DEFAULT_API_KEY_LIFETIME,
  MAX_API_KEY_NAME_LENGTH,
} from '@server/constants/apiKeys';
import axios, { isAxiosError } from 'axios';
import { useRouter } from 'next/router';
import { Fragment, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import useClipboard from 'react-use-clipboard';
import useSWR from 'swr';

const messages = defineMessages(
  'components.UserProfile.UserSettings.UserApiKeySettings',
  {
    apiKeys: 'API Keys',
    hint: 'Let an app or script act as you, such as Home Assistant. A key can do anything you can, so keep it safe.',
    othersHint:
      'Keys {name} made for apps and scripts. Revoke any that are lost or unused.',
    make: 'Make an API Key',
    none: 'No API keys yet.',
    othersNone: 'No API keys.',
    loadFailed: 'API keys could not be loaded.',
    switchedOff:
      'API keys are turned off on this server, so existing keys don’t work.',
    notAllowed:
      'Only admins and user managers can use API keys here. Other people’s keys don’t work for now.',
    atLimit:
      'You have {limit} API keys, the most you can have. Revoke one to make another.',
    made: 'Made {date}',
    lastUsed: 'last used {date}',
    neverUsed: 'not used yet',
    expires: 'expires {date}',
    expiredOn: 'expired {date}',
    neverExpires: 'never expires',
    expired: 'Expired',
    revoke: 'Revoke',
    revoked: 'API key revoked. Apps using it can no longer get in.',
    changeFailed: 'That did not work. Check your connection and try again.',
    name: 'Name',
    namePlaceholder: 'Home Assistant',
    nameTip: 'What it’s for, so you can tell your keys apart.',
    lifetime: 'Expires',
    days: '{days, plural, one {# day} other {# days}}',
    oneYear: '1 year',
    never: 'Never',
    neverTip: 'A key that never expires keeps working until you revoke it.',
    makeButton: 'Make Key',
    making: 'Making…',
    makeFailed: 'The key could not be made.',
    newTitle: 'Your New API Key',
    copyNow: 'Copy it now and keep it safe. You won’t see it again.',
    howToUse: 'Apps send it in the X-Api-Key header.',
    copy: 'Copy',
    copied: 'Copied',
    done: 'Done',
  }
);

const LIFETIME_VALUE = (lifetime: ApiKeyLifetime) =>
  lifetime === null ? 'never' : String(lifetime);

/** The visible start of a key, with the rest left out. */
const Prefix = ({ prefix }: { prefix: string }) => (
  <code className="rounded bg-gray-700/60 px-1.5 py-0.5 font-mono text-xs text-gray-200">
    {prefix}…
  </code>
);

/** The new key, once: shown in full with a copy button that says so. */
const NewKey = ({ secret }: { secret: string }) => {
  const intl = useIntl();
  const [copied, copy] = useClipboard(secret, { successDuration: 3000 });
  const inputId = useId();

  return (
    <div className="space-y-4">
      <Alert type="warning" title={intl.formatMessage(messages.copyNow)} />
      <div>
        <label htmlFor={inputId} className="sr-only">
          {intl.formatMessage(messages.newTitle)}
        </label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          {/* All of it on show, on a phone too: wrapped, not cut off. */}
          <textarea
            id={inputId}
            readOnly
            rows={2}
            value={secret}
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 resize-none break-all font-mono text-sm sm:py-2"
            onFocus={(e) => e.target.select()}
          />
          <Button
            type="button"
            buttonType={copied ? 'success' : 'primary'}
            onClick={copy}
            className="flex-none justify-center"
          >
            {copied ? <CheckIcon /> : <ClipboardDocumentIcon />}
            <span aria-live="polite">
              {intl.formatMessage(copied ? messages.copied : messages.copy)}
            </span>
          </Button>
        </div>
        <p className="mt-2 text-sm text-gray-400">
          {intl.formatMessage(messages.howToUse)}
        </p>
      </div>
    </div>
  );
};

const UserApiKeySettings = () => {
  const intl = useIntl();
  const router = useRouter();
  const { addToast } = useToasts();
  const { user: currentUser, hasPermission } = useUser();
  const { user } = useUser({ id: Number(router.query.userId) });
  const isOwn = !!user && currentUser?.id === user.id;
  // Someone who manages users can see and revoke another person's keys;
  // the server decides whose, and keeps the owner's and other admins' to
  // the owner.
  const managing = !!user && !isOwn && hasPermission(Permission.MANAGE_USERS);
  const endpoint =
    user && (isOwn || managing)
      ? `/api/v1/user/${user.id}/settings/api-keys`
      : null;
  const { data, error, mutate } = useSWR<ApiKeyListResponse>(endpoint);

  const [making, setMaking] = useState(false);
  const [name, setName] = useState('');
  const [lifetime, setLifetime] = useState<ApiKeyLifetime>(
    DEFAULT_API_KEY_LIFETIME
  );
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<ApiKeyCreatedResponse>();
  const nameId = useId();
  const lifetimeId = useId();

  const openDialog = () => {
    setName('');
    setLifetime(DEFAULT_API_KEY_LIFETIME);
    setCreated(undefined);
    setMaking(true);
  };

  // The new key is forgotten once the dialog has gone (afterLeave), so it
  // doesn't flip back to the form on its way out.
  const closeDialog = () => setMaking(false);

  const make = async () => {
    if (!user || !name.trim() || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      const res = await axios.post<ApiKeyCreatedResponse>(
        `/api/v1/user/${user.id}/settings/api-keys`,
        { name: name.trim(), expiresInDays: lifetime }
      );
      setCreated(res.data);
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

  const revoke = async (key: ApiKeySummary) => {
    try {
      await axios.delete(`${endpoint}/${key.id}`);
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

  const liveKeys = data?.keys.filter((key) => !key.expired).length ?? 0;
  const canMake = isOwn && data?.status === 'on' && liveKeys < data.limit;
  const lifetimeLabel = (option: ApiKeyLifetime) =>
    option === null
      ? intl.formatMessage(messages.never)
      : option === 365
        ? intl.formatMessage(messages.oneYear)
        : intl.formatMessage(messages.days, { days: option });

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.apiKeys),
          intl.formatMessage(globalMessages.usersettings),
          user?.displayName,
        ]}
      />
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <h3 className="heading">{intl.formatMessage(messages.apiKeys)}</h3>
          <h6 className="description">
            {isOwn
              ? intl.formatMessage(messages.hint)
              : intl.formatMessage(messages.othersHint, {
                  name: user?.displayName,
                })}
          </h6>
        </div>
        {canMake && (
          <Button buttonType="primary" onClick={openDialog}>
            <PlusIcon />
            <span>{intl.formatMessage(messages.make)}</span>
          </Button>
        )}
      </div>

      {!data && !error && <LoadingSpinner />}
      {error && !data && (
        <Alert type="error" title={intl.formatMessage(messages.loadFailed)} />
      )}

      {data && data.status !== 'on' && (data.keys.length > 0 || isOwn) && (
        <div className="mb-4">
          <Alert
            type="warning"
            title={intl.formatMessage(
              data.status === 'off' ? messages.switchedOff : messages.notAllowed
            )}
          />
        </div>
      )}
      {isOwn && data?.status === 'on' && liveKeys >= data.limit && (
        <div className="mb-4">
          <Alert
            type="info"
            title={intl.formatMessage(messages.atLimit, { limit: data.limit })}
          />
        </div>
      )}

      {data && data.keys.length === 0 && (
        <div className="mt-4 text-center md:py-12">
          <h3 className="text-lg font-semibold text-gray-400">
            {intl.formatMessage(isOwn ? messages.none : messages.othersNone)}
          </h3>
        </div>
      )}

      {data && data.keys.length > 0 && (
        <ul className="space-y-4">
          {data.keys.map((key) => (
            <li
              key={key.id}
              className="flex flex-wrap items-center gap-4 rounded-lg bg-gray-800/50 px-4 py-5 shadow ring-1 ring-gray-700 sm:p-6"
            >
              <div className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-gray-700 sm:h-12 sm:w-12">
                <KeyIcon
                  className={`h-6 w-6 ${
                    key.expired
                      ? 'text-gray-400'
                      : 'text-indigo-300 light:text-accent-text'
                  }`}
                  aria-hidden="true"
                />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-lg font-semibold text-strong">
                    {key.name}
                  </span>
                  <Prefix prefix={key.prefix} />
                  {key.expired && (
                    <span className="flex-none rounded-full bg-red-600/40 px-2 py-0.5 text-xs text-red-100 light:text-red-700">
                      {intl.formatMessage(messages.expired)}
                    </span>
                  )}
                </div>
                <div className="mt-1 text-sm text-gray-400">
                  {intl.formatMessage(messages.made, {
                    date: date(key.createdAt),
                  })}
                  {' · '}
                  {key.lastUsedAt
                    ? intl.formatMessage(messages.lastUsed, {
                        date: date(key.lastUsedAt),
                      })
                    : intl.formatMessage(messages.neverUsed)}
                  {' · '}
                  {key.expiresAt
                    ? intl.formatMessage(
                        key.expired ? messages.expiredOn : messages.expires,
                        { date: date(key.expiresAt) }
                      )
                    : intl.formatMessage(messages.neverExpires)}
                </div>
              </div>
              <div className="flex w-full flex-none justify-end sm:w-auto">
                <ConfirmButton
                  onClick={() => revoke(key)}
                  confirmText={intl.formatMessage(globalMessages.areyousure)}
                >
                  <TrashIcon />
                  <span>{intl.formatMessage(messages.revoke)}</span>
                </ConfirmButton>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Transition
        as={Fragment}
        show={making}
        afterLeave={() => setCreated(undefined)}
        enter="transition-opacity ease-in-out duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity ease-in-out duration-300"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
      >
        <Modal
          title={intl.formatMessage(
            created ? messages.newTitle : messages.make
          )}
          subTitle={created?.key.name}
          okText={intl.formatMessage(
            created
              ? messages.done
              : submitting
                ? messages.making
                : messages.makeButton
          )}
          okDisabled={!created && (!name.trim() || submitting)}
          onOk={created ? closeDialog : make}
          onCancel={created ? undefined : closeDialog}
          // Once the key is shown, a stray click or Escape must not lose a
          // key that is shown only this once: Done closes it.
          backgroundClickable={!created}
        >
          {created ? (
            <NewKey secret={created.secret} />
          ) : (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                make();
              }}
            >
              <div>
                <label htmlFor={nameId} className="text-label">
                  {intl.formatMessage(messages.name)}
                </label>
                <input
                  id={nameId}
                  type="text"
                  className="mt-1 w-full"
                  value={name}
                  maxLength={MAX_API_KEY_NAME_LENGTH}
                  placeholder={intl.formatMessage(messages.namePlaceholder)}
                  aria-describedby={`${nameId}-tip`}
                  autoComplete="off"
                  onChange={(e) => setName(e.target.value)}
                />
                <p id={`${nameId}-tip`} className="mt-1 text-sm text-gray-400">
                  {intl.formatMessage(messages.nameTip)}
                </p>
              </div>
              <div>
                <label htmlFor={lifetimeId} className="text-label">
                  {intl.formatMessage(messages.lifetime)}
                </label>
                <select
                  id={lifetimeId}
                  className="mt-1 w-full"
                  value={LIFETIME_VALUE(lifetime)}
                  aria-describedby={
                    lifetime === null ? `${lifetimeId}-tip` : undefined
                  }
                  onChange={(e) =>
                    setLifetime(
                      API_KEY_LIFETIMES.find(
                        (option) => LIFETIME_VALUE(option) === e.target.value
                      ) ?? DEFAULT_API_KEY_LIFETIME
                    )
                  }
                >
                  {API_KEY_LIFETIMES.map((option) => (
                    <option
                      key={LIFETIME_VALUE(option)}
                      value={LIFETIME_VALUE(option)}
                    >
                      {lifetimeLabel(option)}
                    </option>
                  ))}
                </select>
                {lifetime === null && (
                  <p
                    id={`${lifetimeId}-tip`}
                    className="mt-1 text-sm text-gray-400"
                  >
                    {intl.formatMessage(messages.neverTip)}
                  </p>
                )}
              </div>
            </form>
          )}
        </Modal>
      </Transition>
    </>
  );
};

export default UserApiKeySettings;
