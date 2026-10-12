import TautulliLogo from '@app/assets/services/tautulli.svg';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import ServerInstance from '@app/components/Settings/ServerInstance';
import type { ShownTautulli } from '@app/components/Settings/TautulliModal';
import TautulliModal from '@app/components/Settings/TautulliModal';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { PlusIcon } from '@heroicons/react/24/solid';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Settings.SettingsTautulli', {
  title: 'Tautulli',
  description:
    'Link Tautulli for what people have watched on Plex: Suggested for You, “up next” on lists, Who Watched, Pick for the Room and Catch Me Up.',
  addTautulli: 'Add Tautulli',
  watchHistory: 'Watch history',
  fromPlex: 'From Plex',
  deleteTautulli: 'Disconnect Tautulli',
  deleteTautulliConfirm:
    'Disconnect Tautulli? Watch history is no longer read until it is added again.',
  deleteFailed: 'Could not disconnect Tautulli.',
});

/*
 * Tautulli, laid out like the other services: its tile with Edit and Delete
 * once it is set up, a dashed tile to add it before. Plex only.
 */
const SettingsTautulli = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, error, mutate } = useSWR<ShownTautulli>(
    '/api/v1/settings/tautulli'
  );
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const configured = !!data?.hostname && !!data.hasApiKey;

  const refresh = () => void mutate();

  const disconnect = async () => {
    try {
      await axios.delete('/api/v1/settings/tautulli');
      refresh();
    } catch {
      addToast(intl.formatMessage(messages.deleteFailed), {
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
        <TautulliModal
          tautulli={configured ? (data ?? null) : null}
          onClose={() => setEditing(false)}
          onSave={() => {
            refresh();
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
          onOk={() => disconnect()}
          onCancel={() => setDeleting(false)}
          title={intl.formatMessage(messages.deleteTautulli)}
        >
          {intl.formatMessage(messages.deleteTautulliConfirm)}
        </Modal>
      </Transition>
      <div className="section">
        {!data && !error && <LoadingSpinner />}
        {data && !error && (
          <ul className="grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-2 xl:grid-cols-3">
            {configured ? (
              <ServerInstance
                name="Tautulli"
                hostname={data.hostname ?? ''}
                port={data.port ?? 8181}
                isSSL={!!data.useSsl}
                externalUrl={data.externalUrl || undefined}
                logo={<TautulliLogo className="h-10 w-10 flex-shrink-0" />}
                detail={{
                  label: intl.formatMessage(messages.watchHistory),
                  value: intl.formatMessage(messages.fromPlex),
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
                    <span>{intl.formatMessage(messages.addTautulli)}</span>
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

export default SettingsTautulli;
