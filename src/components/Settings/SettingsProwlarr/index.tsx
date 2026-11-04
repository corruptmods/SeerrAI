import ProwlarrLogo from '@app/assets/services/prowlarr.svg';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import type { ShownProwlarr } from '@app/components/Settings/ProwlarrModal';
import ProwlarrModal from '@app/components/Settings/ProwlarrModal';
import ServerInstance from '@app/components/Settings/ServerInstance';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { PlusIcon } from '@heroicons/react/24/solid';
import axios, { isAxiosError } from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate as globalMutate } from 'swr';

const messages = defineMessages('components.Settings.SettingsProwlarr', {
  prowlarr: 'Prowlarr',
  description:
    'Backfill and songs taken from albums search Prowlarr directly, under every name a title goes by. Neither runs without it. Sonarr, Radarr and Lidarr keep using their own indexers.',
  addProwlarr: 'Add Prowlarr',
  usedBy: 'Used by',
  backfillAndSongs: 'Backfill and songs taken from albums',
  deleteProwlarr: 'Disconnect Prowlarr',
  deleteProwlarrConfirm:
    'Disconnect Prowlarr? Backfill and songs taken from albums can’t search until it is added again.',
  deleteFailed: 'Could not disconnect Prowlarr: {reason}',
  noAnswer: 'it did not answer.',
});

/*
 * Prowlarr, laid out like the other services: its tile with Edit and Delete
 * once it is set up, a dashed tile to add it before. Its connection is kept
 * with Backfill's settings, which use it.
 */
const SettingsProwlarr = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, error, mutate } = useSWR<ShownProwlarr>(
    '/api/v1/settings/backfill/prowlarr'
  );
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const configured = !!data?.hostname && !!data.hasApiKey;

  // Backfill's own settings show whether Prowlarr is set up.
  const refresh = () => {
    void mutate();
    void globalMutate('/api/v1/settings/backfill');
  };

  // A blank address takes Prowlarr out; the server refuses while Backfill
  // is on, and says so.
  const disconnect = async () => {
    try {
      await axios.put('/api/v1/settings/backfill/prowlarr', {
        hostname: '',
        port: data?.port ?? 9696,
        useSsl: false,
        urlBase: '',
        apiKey: '',
      });
      refresh();
    } catch (e) {
      addToast(
        intl.formatMessage(messages.deleteFailed, {
          reason:
            (isAxiosError(e) &&
              (e.response?.data as { message?: string })?.message) ||
            intl.formatMessage(messages.noAnswer),
        }),
        { appearance: 'error', autoDismiss: true }
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <div className="mb-6 mt-10">
        <h3 className="heading">{intl.formatMessage(messages.prowlarr)}</h3>
        <p className="description">
          {intl.formatMessage(messages.description)}
        </p>
      </div>
      {editing && (
        <ProwlarrModal
          prowlarr={configured ? (data ?? null) : null}
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
          title={intl.formatMessage(messages.deleteProwlarr)}
        >
          {intl.formatMessage(messages.deleteProwlarrConfirm)}
        </Modal>
      </Transition>
      <div className="section">
        {!data && !error && <LoadingSpinner />}
        {data && !error && (
          <ul className="grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-2 xl:grid-cols-3">
            {configured ? (
              <ServerInstance
                name="Prowlarr"
                hostname={data.hostname}
                port={data.port}
                isSSL={data.useSsl}
                logo={
                  <ProwlarrLogo className="service-logo h-10 w-10 flex-shrink-0" />
                }
                detail={{
                  label: intl.formatMessage(messages.usedBy),
                  value: intl.formatMessage(messages.backfillAndSongs),
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
                    <span>{intl.formatMessage(messages.addProwlarr)}</span>
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

export default SettingsProwlarr;
