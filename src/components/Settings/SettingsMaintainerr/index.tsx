import MaintainerrLogo from '@app/assets/services/maintainerr.svg';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import MaintainerrModal from '@app/components/Settings/MaintainerrModal';
import ServerInstance from '@app/components/Settings/ServerInstance';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { PlusIcon } from '@heroicons/react/24/solid';
import type { MaintainerrSettings } from '@server/lib/settings';
import axios from 'axios';
import { Fragment, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { useSWRConfig } from 'swr';

const messages = defineMessages('components.Settings.SettingsMaintainerr', {
  maintainerrSettings: 'Maintainerr Settings',
  maintainerrSettingsDescription:
    'Connect Maintainerr to warn people before titles are deleted and let them keep what they are still watching. Each server has its own features.',
  addmaintainerr: 'Add Maintainerr Server',
  features: 'Features',
  badges: 'Badges',
  homeRow: 'Home row',
  keep: 'Keep',
  none: 'None',
  deleteServer: 'Delete Maintainerr Server',
  deleteServerConfirm: 'Are you sure you want to delete this server?',
  deleteFailed: 'Could not delete the server.',
});

/*
 * Maintainerr servers, laid out like the Radarr and Sonarr sections: a tile per
 * server with Edit and Delete, a dashed tile to add one, and a dialog for the
 * details.
 */
const SettingsMaintainerr = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { mutate: mutateGlobal } = useSWRConfig();
  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<MaintainerrSettings[]>('/api/v1/settings/maintainerr');
  const [editModal, setEditModal] = useState<{
    open: boolean;
    maintainerr: MaintainerrSettings | null;
  }>({ open: false, maintainerr: null });
  const [deleteModal, setDeleteModal] = useState<{
    open: boolean;
    serverId: number | null;
  }>({ open: false, serverId: null });

  // Badges, the home row and Keep all read the schedule; refresh it too.
  const refreshEverything = () => {
    revalidate();
    mutateGlobal('/api/v1/maintainerr/deleting');
  };

  const deleteServer = async () => {
    try {
      await axios.delete(
        `/api/v1/settings/maintainerr/${deleteModal.serverId}`
      );
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

  const featureList = (server: MaintainerrSettings) => {
    const on = [
      server.showBadges && intl.formatMessage(messages.badges),
      server.showDeletingSoon && intl.formatMessage(messages.homeRow),
      server.allowKeep && intl.formatMessage(messages.keep),
    ].filter(Boolean);
    return on.length ? on.join(', ') : intl.formatMessage(messages.none);
  };

  return (
    <>
      <div className="mb-6 mt-10">
        <h3 className="heading">
          {intl.formatMessage(messages.maintainerrSettings)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.maintainerrSettingsDescription)}
        </p>
      </div>
      {editModal.open && (
        <MaintainerrModal
          maintainerr={editModal.maintainerr}
          onClose={() => setEditModal({ open: false, maintainerr: null })}
          onSave={() => {
            refreshEverything();
            setEditModal({ open: false, maintainerr: null });
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
          <ul className="grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-2 xl:grid-cols-3">
            {data.map((server) => (
              <ServerInstance
                key={`maintainerr-config-${server.id}`}
                name={server.name}
                hostname={server.hostname}
                port={server.port}
                isSSL={server.useSsl}
                logo={
                  <MaintainerrLogo className="service-logo h-10 w-10 flex-shrink-0" />
                }
                detail={{
                  label: intl.formatMessage(messages.features),
                  value: featureList(server),
                }}
                onEdit={() => setEditModal({ open: true, maintainerr: server })}
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
                  onClick={() =>
                    setEditModal({ open: true, maintainerr: null })
                  }
                >
                  <PlusIcon />
                  <span>{intl.formatMessage(messages.addmaintainerr)}</span>
                </Button>
              </div>
            </li>
          </ul>
        )}
      </div>
    </>
  );
};

export default SettingsMaintainerr;
