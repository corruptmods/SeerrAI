import TraktLogo from '@app/assets/services/trakt.svg';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import ServerInstance from '@app/components/Settings/ServerInstance';
import TraktModal from '@app/components/Settings/TraktModal';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { PlusIcon } from '@heroicons/react/24/solid';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate as globalMutate } from 'swr';

const messages = defineMessages('components.Settings.SettingsTrakt', {
  title: 'Trakt',
  description:
    'The key Seerr AI reads Trakt with. With it, people can paste a public Trakt list or watchlist link into Import on any of their lists, and have their public Trakt watchlist requested (in their profile). Nobody signs in to Trakt.',
  addTrakt: 'Add Trakt',
  usedBy: 'Used by',
  listsAndWatchlists: 'List imports and watchlists',
  removed: 'Trakt removed.',
  removeTitle: 'Remove Trakt',
  removeConfirm:
    'Remove Trakt? Trakt imports and watchlist requests stop until a Client ID is saved again.',
  removeFailed: 'Could not remove Trakt.',
});

/*
 * Trakt, laid out like the other services: its tile with Edit and Delete once
 * a Client ID is saved, else a dashed tile to add one.
 */
const SettingsTrakt = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, error, mutate } = useSWR<{ hasClientId: boolean }>(
    '/api/v1/settings/trakt'
  );
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const refresh = async () => {
    await mutate();
    // The Import box and profile settings read whether Trakt is ready.
    await globalMutate('/api/v1/settings/public');
  };

  const remove = async () => {
    try {
      await axios.delete('/api/v1/settings/trakt');
      await refresh();
      addToast(intl.formatMessage(messages.removed), {
        appearance: 'info',
        autoDismiss: true,
      });
    } catch {
      addToast(intl.formatMessage(messages.removeFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setDeleting(false);
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
      {editing && (
        <TraktModal
          saved={!!data?.hasClientId}
          onClose={() => setEditing(false)}
          onSave={() => {
            void refresh();
            setEditing(false);
          }}
        />
      )}
      <Transition
        as="div"
        show={deleting}
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
          onOk={() => void remove()}
          onCancel={() => setDeleting(false)}
          title={intl.formatMessage(messages.removeTitle)}
        >
          {intl.formatMessage(messages.removeConfirm)}
        </Modal>
      </Transition>
      <div className="section">
        {!data && !error && <LoadingSpinner />}
        {data && !error && (
          <ul className="grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-2 xl:grid-cols-3">
            {data.hasClientId ? (
              <ServerInstance
                name="Trakt"
                hostname="api.trakt.tv"
                port={443}
                isSSL
                externalUrl="https://trakt.tv"
                address="trakt.tv"
                logo={
                  <TraktLogo className="service-logo h-10 w-10 flex-shrink-0" />
                }
                detail={{
                  label: intl.formatMessage(messages.usedBy),
                  value: intl.formatMessage(messages.listsAndWatchlists),
                }}
                onEdit={() => setEditing(true)}
                onDelete={() => setDeleting(true)}
              />
            ) : (
              <li className="col-span-1 h-32 rounded-lg border-2 border-dashed border-gray-400 shadow sm:h-44">
                <div className="flex h-full w-full items-center justify-center">
                  <Button
                    buttonType="ghost"
                    className="mb-3 mt-3"
                    onClick={() => setEditing(true)}
                  >
                    <PlusIcon />
                    <span>{intl.formatMessage(messages.addTrakt)}</span>
                  </Button>
                </div>
              </li>
            )}
          </ul>
        )}
      </div>
    </>
  );
};

export default SettingsTrakt;
