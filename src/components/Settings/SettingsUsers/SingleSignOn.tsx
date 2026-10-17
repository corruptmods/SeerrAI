import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import CopyButton from '@app/components/Settings/CopyButton';
import type { ShownOidcProvider } from '@app/components/Settings/OidcProviderModal';
import useLazyModule from '@app/hooks/useLazyModule';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { KeyIcon } from '@heroicons/react/24/outline';
import {
  ArrowPathIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from '@heroicons/react/24/solid';
import axios from 'axios';
import Link from 'next/link';
import { Fragment, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';

const messages = defineMessages(
  'components.Settings.SettingsUsers.SingleSignOn',
  {
    title: 'Single Sign-On',
    description:
      'Let people sign in with an identity provider such as Authentik, Authelia, Keycloak, Pocket ID or Google. Each provider gets a "Sign in with" button on the sign-in page, and people can link it to the account they already have in Profile → Linked Accounts. Signing out of Seerr AI does not sign them out of the provider.',
    needsApplicationUrl:
      'Set the Application URL in Settings → General first. Providers send people back to Seerr AI at that address, so it must be the address people use.',
    openGeneral: 'Open Settings → General',
    addProvider: 'Add Provider',
    enabled: 'Enabled',
    disabled: 'Disabled',
    signUp: 'New people can sign up',
    id: 'ID',
    issuer: 'Issuer',
    redirectUrl: 'Redirect URL',
    redirectUrlCopied: 'Redirect URL copied.',
    deleteProvider: 'Delete Provider',
    deleteProviderConfirm:
      'People can no longer sign in with {name}. Their links to it are kept but unused, and a provider added later is never matched to them.',
    deleteFailed: 'Could not delete the provider.',
    couldNotOpen:
      'That could not be opened. Check your connection and try again.',
    loadFailed: 'The single sign-on providers could not be loaded.',
  }
);

interface OidcSettingsResponse {
  applicationUrl: string;
  providers: ShownOidcProvider[];
  takenIds: string[];
}

const loadModal = () => import('@app/components/Settings/OidcProviderModal');

/*
 * Settings → Users → Single Sign-On: a tile per provider with Edit and
 * Delete, a dashed tile to add one, and a dialog for the details.
 */
const SingleSignOn = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<OidcSettingsResponse>('/api/v1/settings/oidc');
  const [editing, setEditing] = useState<{
    provider: ShownOidcProvider | null;
  }>();
  const [deleting, setDeleting] = useState<ShownOidcProvider>();
  const modal = useLazyModule(loadModal, !!editing, () => {
    addToast(intl.formatMessage(messages.couldNotOpen), {
      appearance: 'error',
      autoDismiss: true,
    });
    setEditing(undefined);
  });

  const changed = () => {
    revalidate();
    // The sign-in page's buttons.
    mutate('/api/v1/settings/public');
  };

  const deleteProvider = async () => {
    try {
      await axios.delete(
        `/api/v1/settings/oidc/${encodeURIComponent(deleting?.id ?? '')}`
      );
      changed();
    } catch {
      addToast(intl.formatMessage(messages.deleteFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setDeleting(undefined);
    }
  };

  return (
    <>
      <div className="mb-6 mt-10">
        <h3 className="heading">{intl.formatMessage(messages.title)}</h3>
        <p className="description">
          {intl.formatMessage(messages.description)}
        </p>
      </div>
      {editing && modal && data && (
        <modal.default
          provider={editing.provider}
          applicationUrl={data.applicationUrl}
          takenIds={data.takenIds}
          onClose={() => setEditing(undefined)}
          onSave={() => {
            changed();
            setEditing(undefined);
          }}
        />
      )}
      <Transition
        as={Fragment}
        show={!!deleting}
        enter="transition-opacity ease-in-out duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity ease-in-out duration-300"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
      >
        <Modal
          okText={intl.formatMessage(globalMessages.delete)}
          okButtonType="danger"
          onOk={() => deleteProvider()}
          onCancel={() => setDeleting(undefined)}
          title={intl.formatMessage(messages.deleteProvider)}
        >
          {intl.formatMessage(messages.deleteProviderConfirm, {
            name: deleting?.name,
          })}
        </Modal>
      </Transition>
      <div className="section">
        {!data && !error && <LoadingSpinner />}
        {error && !data && (
          <Alert type="error" title={intl.formatMessage(messages.loadFailed)}>
            <Button buttonSize="sm" onClick={() => revalidate()}>
              <ArrowPathIcon />
              <span>{intl.formatMessage(globalMessages.retry)}</span>
            </Button>
          </Alert>
        )}
        {data && !data.applicationUrl && (
          <Alert title={intl.formatMessage(messages.needsApplicationUrl)}>
            <Link href="/settings/main" className="underline">
              {intl.formatMessage(messages.openGeneral)}
            </Link>
          </Alert>
        )}
        {data && (
          <ul className="grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-2">
            {data.providers.map((provider) => (
              <li
                key={provider.id}
                className="col-span-1 rounded-lg bg-gray-800 shadow ring-1 ring-gray-500"
              >
                <div className="flex w-full items-center justify-between space-x-6 p-6">
                  <div className="min-w-0 flex-1">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <h4 className="truncate font-medium leading-5 text-strong">
                        {provider.name}
                      </h4>
                      {provider.enabled ? (
                        <Badge badgeType="success">
                          {intl.formatMessage(messages.enabled)}
                        </Badge>
                      ) : (
                        <Badge>{intl.formatMessage(messages.disabled)}</Badge>
                      )}
                      {provider.newUserSignUp && (
                        <Badge badgeType="warning">
                          {intl.formatMessage(messages.signUp)}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 truncate text-sm leading-5 text-gray-300">
                      <span className="mr-2 font-bold">
                        {intl.formatMessage(messages.id)}
                      </span>
                      {provider.id}
                    </p>
                    <p className="mt-1 truncate text-sm leading-5 text-gray-300">
                      <span className="mr-2 font-bold">
                        {intl.formatMessage(messages.issuer)}
                      </span>
                      {provider.issuerUrl}
                    </p>
                    {provider.callbackUrl && (
                      <div className="mt-2 text-sm leading-5 text-gray-300">
                        <span className="mr-2 font-bold">
                          {intl.formatMessage(messages.redirectUrl)}
                        </span>
                        <div className="form-input-field mt-1">
                          <input
                            type="text"
                            className="rounded-l-only"
                            value={provider.callbackUrl}
                            aria-label={intl.formatMessage(
                              messages.redirectUrl
                            )}
                            readOnly
                          />
                          <CopyButton
                            textToCopy={provider.callbackUrl}
                            toastMessage={intl.formatMessage(
                              messages.redirectUrlCopied
                            )}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center opacity-50">
                    {provider.logoUrl ? (
                      // A picture the admin chose, from wherever it is kept.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={provider.logoUrl}
                        alt=""
                        className="h-10 w-10 object-contain"
                      />
                    ) : (
                      <KeyIcon className="h-10 w-10 text-gray-300" />
                    )}
                  </div>
                </div>
                <div className="border-t border-gray-500">
                  <div className="-mt-px flex">
                    <div className="flex w-0 flex-1 border-r border-gray-500">
                      <button
                        onClick={() => setEditing({ provider })}
                        className="relative -mr-px inline-flex w-0 flex-1 items-center justify-center rounded-bl-lg border border-transparent py-4 text-sm font-medium leading-5 text-gray-200 transition duration-150 ease-in-out hover:text-strong focus:z-10 focus:border-gray-500 focus:outline-none"
                      >
                        <PencilIcon className="mr-2 h-5 w-5" />
                        <span>{intl.formatMessage(globalMessages.edit)}</span>
                      </button>
                    </div>
                    <div className="-ml-px flex w-0 flex-1">
                      <button
                        onClick={() => setDeleting(provider)}
                        className="relative inline-flex w-0 flex-1 items-center justify-center rounded-br-lg border border-transparent py-4 text-sm font-medium leading-5 text-gray-200 transition duration-150 ease-in-out hover:text-strong focus:z-10 focus:border-gray-500 focus:outline-none"
                      >
                        <TrashIcon className="mr-2 h-5 w-5" />
                        <span>{intl.formatMessage(globalMessages.delete)}</span>
                      </button>
                    </div>
                  </div>
                </div>
              </li>
            ))}
            <li className="col-span-1 h-32 rounded-lg border-2 border-dashed border-gray-400 shadow sm:h-44">
              <div className="flex h-full w-full items-center justify-center">
                <Button
                  buttonType="ghost"
                  className="mb-3 mt-3"
                  onClick={() => setEditing({ provider: null })}
                >
                  <PlusIcon />
                  <span>{intl.formatMessage(messages.addProvider)}</span>
                </Button>
              </div>
            </li>
          </ul>
        )}
      </div>
    </>
  );
};

export default SingleSignOn;
