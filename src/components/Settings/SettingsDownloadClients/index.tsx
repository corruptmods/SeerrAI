import DelugeLogo from '@app/assets/services/deluge.svg';
import NzbgetLogo from '@app/assets/services/nzbget.svg';
import QbittorrentLogo from '@app/assets/services/qbittorrent.svg';
import RtorrentLogo from '@app/assets/services/rtorrent.svg';
import SabnzbdLogo from '@app/assets/services/sabnzbd.svg';
import TransmissionLogo from '@app/assets/services/transmission.svg';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import type { ShownDownloadClient } from '@app/components/Settings/DownloadClientModal';
import DownloadClientModal from '@app/components/Settings/DownloadClientModal';
import ServerInstance from '@app/components/Settings/ServerInstance';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { PlusIcon } from '@heroicons/react/24/solid';
import axios from 'axios';
import { Fragment, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Settings.SettingsDownloadClients', {
  title: 'Download Clients',
  description:
    'Shows live download progress and what the client is doing. Radarr and Sonarr still send downloads; Backfill can use any.',
  addClient: 'Add Download Client',
  client: 'Client',
  sabnzbd: 'SABnzbd',
  nzbget: 'NZBGet',
  qbittorrent: 'qBittorrent',
  transmission: 'Transmission',
  deluge: 'Deluge',
  rtorrent: 'rTorrent',
  deleteClient: 'Delete Download Client',
  deleteClientConfirm: 'Delete this download client?',
  deleteFailed: 'Could not delete the download client.',
});

/** Each client's own logo, as Radarr's and Sonarr's tiles show theirs. */
const LOGOS: Record<
  ShownDownloadClient['type'],
  React.FC<React.SVGProps<SVGSVGElement>>
> = {
  sabnzbd: SabnzbdLogo,
  nzbget: NzbgetLogo,
  qbittorrent: QbittorrentLogo,
  transmission: TransmissionLogo,
  deluge: DelugeLogo,
  rtorrent: RtorrentLogo,
};

/*
 * Download clients, laid out like the Maintainerr section: a tile per client
 * with Edit and Delete, a dashed tile to add one, and a dialog for the
 * details.
 */
const SettingsDownloadClients = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<ShownDownloadClient[]>('/api/v1/settings/download-clients');
  const [editModal, setEditModal] = useState<{
    open: boolean;
    client: ShownDownloadClient | null;
  }>({ open: false, client: null });
  const [deleteModal, setDeleteModal] = useState<{
    open: boolean;
    clientId: number | null;
  }>({ open: false, clientId: null });

  const deleteClient = async () => {
    try {
      await axios.delete(
        `/api/v1/settings/download-clients/${deleteModal.clientId}`
      );
      revalidate();
    } catch {
      addToast(intl.formatMessage(messages.deleteFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setDeleteModal({ open: false, clientId: null });
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
      {editModal.open && (
        <DownloadClientModal
          client={editModal.client}
          onClose={() => setEditModal({ open: false, client: null })}
          onSave={() => {
            revalidate();
            setEditModal({ open: false, client: null });
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
          onOk={() => deleteClient()}
          onCancel={() => setDeleteModal({ open: false, clientId: null })}
          title={intl.formatMessage(messages.deleteClient)}
        >
          {intl.formatMessage(messages.deleteClientConfirm)}
        </Modal>
      </Transition>
      <div className="section">
        {!data && !error && <LoadingSpinner />}
        {data && !error && (
          <ul className="grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-2 xl:grid-cols-3">
            {data.map((client) => {
              const Logo = LOGOS[client.type];
              return (
                <ServerInstance
                  key={`download-client-${client.id}`}
                  name={client.name}
                  hostname={client.hostname}
                  port={client.port}
                  isSSL={client.useSsl}
                  logo={
                    <Logo className="service-logo h-10 w-10 flex-shrink-0" />
                  }
                  detail={{
                    label: intl.formatMessage(messages.client),
                    value: intl.formatMessage(messages[client.type]),
                  }}
                  onEdit={() => setEditModal({ open: true, client })}
                  onDelete={() =>
                    setDeleteModal({ open: true, clientId: client.id })
                  }
                />
              );
            })}
            <li className="col-span-1 h-32 rounded-lg border-2 border-dashed border-gray-400 shadow sm:h-44">
              <div className="flex h-full w-full items-center justify-center">
                <Button
                  buttonType="ghost"
                  className="mb-3 mt-3"
                  onClick={() => setEditModal({ open: true, client: null })}
                >
                  <PlusIcon />
                  <span>{intl.formatMessage(messages.addClient)}</span>
                </Button>
              </div>
            </li>
          </ul>
        )}
      </div>
    </>
  );
};

export default SettingsDownloadClients;
