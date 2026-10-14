import LidarrLogo from '@app/assets/services/lidarr.svg';
import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import ServerInstance from '@app/components/Settings/ServerInstance';
import useLazyModule from '@app/hooks/useLazyModule';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { PlusIcon } from '@heroicons/react/24/solid';
import type { LidarrSettings } from '@server/lib/settings';
import axios from 'axios';
import { Fragment, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { useSWRConfig } from 'swr';

const messages = defineMessages('components.Settings.SettingsLidarr', {
  lidarrSettings: 'Lidarr Settings',
  lidarrSettingsDescription:
    'Connect Lidarr to bring music to Seerr AI: once a default Lidarr is added, everyone with music on can find artists and albums in search, on Discover and on their own pages. You can connect several Lidarr servers; one is the default.',
  addlidarr: 'Add Lidarr Server',
  noDefault:
    'Mark one Lidarr server as the default: music appears once one is.',
  deleteServer: 'Delete Lidarr Server',
  deleteServerConfirm: 'Are you sure you want to delete this server?',
  deleteFailed: 'Could not delete the server.',
  couldNotOpen:
    'The Lidarr dialog could not be opened. Check your connection and try again.',
});

// The dialog is only needed by an admin adding or changing a server.
const loadLidarrModal = () =>
  import('@app/components/Settings/LidarrModal').then((m) => m.default);

/*
 * Lidarr servers, for music, laid out like the Radarr and Sonarr sections.
 * The whole section goes while an admin has music turned off for everyone.
 */
const SettingsLidarr = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { currentSettings } = useSettings();
  const { mutate: mutateGlobal } = useSWRConfig();
  const musicOff = currentSettings.disabledFeatures.includes('music');
  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<LidarrSettings[]>(musicOff ? null : '/api/v1/settings/lidarr');
  const [editModal, setEditModal] = useState<{
    open: boolean;
    lidarr: LidarrSettings | null;
  }>({ open: false, lidarr: null });
  const [deleteModal, setDeleteModal] = useState<{
    open: boolean;
    serverId: number | null;
  }>({ open: false, serverId: null });
  const LidarrModal = useLazyModule(loadLidarrModal, editModal.open, () => {
    addToast(intl.formatMessage(messages.couldNotOpen), {
      appearance: 'error',
      autoDismiss: true,
    });
    setEditModal({ open: false, lidarr: null });
  });

  // Whether music is ready depends on there being a default Lidarr.
  const refreshEverything = () => {
    revalidate();
    mutateGlobal('/api/v1/settings/public');
  };

  const deleteServer = async () => {
    try {
      await axios.delete(`/api/v1/settings/lidarr/${deleteModal.serverId}`);
      refreshEverything();
    } catch {
      addToast(intl.formatMessage(messages.deleteFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setDeleteModal({ open: false, serverId: null });
    }
  };

  if (musicOff) {
    return null;
  }

  return (
    <>
      <div className="mb-6 mt-10">
        <h3 className="heading">
          {intl.formatMessage(messages.lidarrSettings)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.lidarrSettingsDescription)}
        </p>
      </div>
      {editModal.open && LidarrModal && (
        <LidarrModal
          lidarr={editModal.lidarr}
          onClose={() => setEditModal({ open: false, lidarr: null })}
          onSave={() => {
            refreshEverything();
            setEditModal({ open: false, lidarr: null });
          }}
        />
      )}
      <Transition
        as={Fragment}
        show={deleteModal.open}
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
          onOk={() => deleteServer()}
          onCancel={() => setDeleteModal({ open: false, serverId: null })}
          title={intl.formatMessage(messages.deleteServer)}
        >
          {intl.formatMessage(messages.deleteServerConfirm)}
        </Modal>
      </Transition>
      <div className="section">
        {!data && !error && <LoadingSpinner />}
        {data && !error && (
          <>
            {data.length > 0 && !data.some((server) => server.isDefault) && (
              <Alert title={intl.formatMessage(messages.noDefault)} />
            )}
            <ul className="grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-2 xl:grid-cols-3">
              {data.map((server) => (
                <ServerInstance
                  key={`lidarr-config-${server.id}`}
                  name={server.name}
                  hostname={server.hostname}
                  port={server.port}
                  profileName={server.activeProfileName}
                  isSSL={server.useSsl}
                  isDefault={server.isDefault}
                  externalUrl={server.externalUrl}
                  logo={<LidarrLogo className="h-10 w-10 flex-shrink-0" />}
                  onEdit={() => setEditModal({ open: true, lidarr: server })}
                  onDelete={() =>
                    setDeleteModal({ open: true, serverId: server.id })
                  }
                />
              ))}
              <li className="col-span-1 h-32 rounded-lg border-2 border-dashed border-gray-400 shadow sm:h-44">
                <div className="flex h-full w-full items-center justify-center">
                  <Button
                    buttonType="ghost"
                    className="mb-3 mt-3"
                    onClick={() => setEditModal({ open: true, lidarr: null })}
                  >
                    <PlusIcon />
                    <span>{intl.formatMessage(messages.addlidarr)}</span>
                  </Button>
                </div>
              </li>
            </ul>
          </>
        )}
      </div>
    </>
  );
};

export default SettingsLidarr;
