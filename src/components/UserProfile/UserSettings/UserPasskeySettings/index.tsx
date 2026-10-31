import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import PageTitle from '@app/components/Common/PageTitle';
import type { Passkey } from '@app/hooks/usePasskeys';
import {
  addPasskey,
  isCancelled,
  preloadPasskeys,
  usePasskeySupport,
} from '@app/hooks/usePasskeys';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  CheckIcon,
  FingerPrintIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import axios, { isAxiosError } from 'axios';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.UserProfile.UserSettings.UserPasskeySettings',
  {
    passkeys: 'Passkeys',
    hint: 'Sign in with Face ID, Touch ID, Windows Hello or a security key. Add one on each device you use.',
    add: 'Add a Passkey',
    none: 'No passkeys yet.',
    added: 'Added {date}',
    lastUsed: 'last used {date}',
    neverUsed: 'not used yet',
    synced: 'Synced',
    rename: 'Rename',
    save: 'Save',
    cancel: 'Cancel',
    addedToast: 'Passkey added. You can now sign in with it.',
    removedToast: 'Passkey removed.',
    failed: 'The passkey could not be added.',
    changeFailed: 'That did not work. Check your connection and try again.',
    unsupported:
      'This browser cannot use passkeys. Passkeys you have added on other devices still work there.',
    onlyYours: 'Passkeys can only be managed by their owner.',
    othersHint:
      'Remove a passkey for a lost or old device. Only they can add one.',
    othersNone: 'No passkeys.',
  }
);

const UserPasskeySettings = () => {
  const intl = useIntl();
  const router = useRouter();
  const { addToast } = useToasts();
  const { user: currentUser, hasPermission } = useUser();
  const { user } = useUser({ id: Number(router.query.userId) });
  const { supported } = usePasskeySupport();
  useEffect(() => {
    if (supported) {
      preloadPasskeys();
    }
  }, [supported]);
  const isOwn = !!user && currentUser?.id === user.id;
  // Someone who manages users can remove another person's passkeys (a lost
  // phone, say); the server decides whose, and refuses the owner's or
  // another admin's to anyone but the owner.
  const managing = !!user && !isOwn && hasPermission(Permission.MANAGE_USERS);
  const endpoint = isOwn
    ? '/api/v1/auth/passkey'
    : managing
      ? `/api/v1/user/${user.id}/settings/passkeys`
      : null;

  const { data: passkeys, error, mutate } = useSWR<Passkey[]>(endpoint);
  const canSee = isOwn || (managing && !error);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<{ id: number; name: string }>();

  const add = async () => {
    setAdding(true);
    try {
      await addPasskey();
      await mutate();
      addToast(intl.formatMessage(messages.addedToast), {
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

  const rename = async () => {
    if (!editing?.name.trim()) {
      return;
    }
    try {
      await axios.put(`/api/v1/auth/passkey/${editing.id}`, {
        name: editing.name,
      });
      setEditing(undefined);
    } catch {
      addToast(intl.formatMessage(messages.changeFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    }
    await mutate();
  };

  const remove = async (passkey: Passkey) => {
    try {
      await axios.delete(`${endpoint}/${passkey.id}`);
      addToast(intl.formatMessage(messages.removedToast), {
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

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.passkeys),
          intl.formatMessage(globalMessages.usersettings),
          user?.displayName,
        ]}
      />
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <h3 className="heading">{intl.formatMessage(messages.passkeys)}</h3>
          <h6 className="description">
            {intl.formatMessage(isOwn ? messages.hint : messages.othersHint)}
          </h6>
        </div>
        {isOwn && supported && (
          <Button buttonType="primary" onClick={add} disabled={adding}>
            <PlusIcon />
            <span>{intl.formatMessage(messages.add)}</span>
          </Button>
        )}
      </div>

      {!canSee && user && (
        <Alert title={intl.formatMessage(messages.onlyYours)} type="info" />
      )}
      {isOwn && supported === false && (
        <Alert title={intl.formatMessage(messages.unsupported)} type="info" />
      )}

      {canSee && passkeys && passkeys.length === 0 && (
        <div className="mt-4 text-center md:py-12">
          <h3 className="text-lg font-semibold text-gray-400">
            {intl.formatMessage(isOwn ? messages.none : messages.othersNone)}
          </h3>
        </div>
      )}

      {canSee && !!passkeys?.length && (
        <ul className="space-y-4">
          {passkeys.map((passkey) => (
            <li
              key={passkey.id}
              className="flex flex-wrap items-center gap-4 rounded-lg bg-gray-800/50 px-4 py-5 shadow ring-1 ring-gray-700 sm:p-6"
            >
              <div className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-gray-700 sm:h-12 sm:w-12">
                <FingerPrintIcon className="h-7 w-7 text-indigo-300 light:text-accent-text" />
              </div>
              <div className="min-w-0 flex-1">
                {editing?.id === passkey.id ? (
                  <input
                    aria-label={intl.formatMessage(messages.rename)}
                    className="w-full max-w-xs"
                    maxLength={64}
                    onChange={(e) =>
                      setEditing({ id: passkey.id, name: e.target.value })
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        rename();
                      }
                      if (e.key === 'Escape') {
                        setEditing(undefined);
                      }
                    }}
                    type="text"
                    value={editing.name}
                  />
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 break-words text-lg font-semibold text-strong">
                      {passkey.name}
                    </span>
                    {passkey.backedUp && (
                      <span className="flex-none rounded-full bg-indigo-600/40 px-2 py-0.5 text-xs text-indigo-100 light:text-accent-text">
                        {intl.formatMessage(messages.synced)}
                      </span>
                    )}
                  </div>
                )}
                <div className="mt-1 text-sm text-gray-400">
                  {intl.formatMessage(messages.added, {
                    date: date(passkey.createdAt),
                  })}
                  {' · '}
                  {passkey.lastUsedAt
                    ? intl.formatMessage(messages.lastUsed, {
                        date: date(passkey.lastUsedAt),
                      })
                    : intl.formatMessage(messages.neverUsed)}
                </div>
              </div>
              <div className="flex w-full flex-none justify-end gap-2 sm:w-auto">
                {editing?.id === passkey.id ? (
                  <>
                    <Button
                      buttonSize="sm"
                      buttonType="primary"
                      disabled={!editing.name.trim()}
                      onClick={rename}
                    >
                      <CheckIcon />
                      <span>{intl.formatMessage(messages.save)}</span>
                    </Button>
                    <Button
                      buttonSize="sm"
                      onClick={() => setEditing(undefined)}
                    >
                      <XMarkIcon />
                      <span>{intl.formatMessage(messages.cancel)}</span>
                    </Button>
                  </>
                ) : (
                  <>
                    {isOwn && (
                      <Button
                        buttonSize="sm"
                        onClick={() =>
                          setEditing({ id: passkey.id, name: passkey.name })
                        }
                      >
                        <PencilIcon />
                        <span>{intl.formatMessage(messages.rename)}</span>
                      </Button>
                    )}
                    <ConfirmButton
                      onClick={() => remove(passkey)}
                      confirmText={intl.formatMessage(
                        globalMessages.areyousure
                      )}
                    >
                      <TrashIcon />
                      <span>{intl.formatMessage(globalMessages.delete)}</span>
                    </ConfirmButton>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
};

export default UserPasskeySettings;
