import SlskdLogo from '@app/assets/services/slskd.svg';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import ServerInstance from '@app/components/Settings/ServerInstance';
import type { ShownSoulseek } from '@app/components/Settings/SoulseekModal';
import SoulseekModal from '@app/components/Settings/SoulseekModal';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { PlusIcon } from '@heroicons/react/24/solid';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Settings.SettingsSoulseek', {
  soulseek: 'Soulseek',
  description:
    'A song taken from an album is looked for on Soulseek, through slskd, when no release of its album or single is on the indexers. Only the song’s file is downloaded, and Lidarr imports it. Needs slskd 0.26 or newer.',
  addSoulseek: 'Add Soulseek',
  downloads: 'Downloads',
  deleteSoulseek: 'Disconnect Soulseek',
  deleteSoulseekConfirm:
    'Disconnect Soulseek? Songs are no longer looked for there until it is added again.',
  deleteFailed: 'Could not disconnect Soulseek.',
});

/** Where slskd is, as the tile shows it. */
const addressOf = (url: string) => {
  try {
    const parsed = new URL(url);
    const isSSL = parsed.protocol === 'https:';
    return {
      hostname: parsed.hostname,
      port: Number(parsed.port) || (isSSL ? 443 : 80),
      isSSL,
    };
  } catch {
    return { hostname: url, port: 5030, isSSL: false };
  }
};

/*
 * Soulseek (through slskd), laid out like the other services: its tile with
 * Edit and Delete once set up, else a dashed tile to add it.
 */
const SettingsSoulseek = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, error, mutate } = useSWR<ShownSoulseek>(
    '/api/v1/settings/music/soulseek'
  );
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const configured = !!data?.url && !!data.hasApiKey;

  // A blank address removes Soulseek.
  const disconnect = async () => {
    try {
      await axios.put('/api/v1/settings/music/soulseek', { url: '' });
      void mutate();
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
        <h3 className="heading">{intl.formatMessage(messages.soulseek)}</h3>
        <p className="description">
          {intl.formatMessage(messages.description)}
        </p>
      </div>
      {editing && (
        <SoulseekModal
          soulseek={configured ? (data ?? null) : null}
          onClose={() => setEditing(false)}
          onSave={() => {
            void mutate();
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
          title={intl.formatMessage(messages.deleteSoulseek)}
        >
          {intl.formatMessage(messages.deleteSoulseekConfirm)}
        </Modal>
      </Transition>
      <div className="section">
        {!data && !error && <LoadingSpinner />}
        {data && !error && (
          <ul className="grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-2 xl:grid-cols-3">
            {configured ? (
              <ServerInstance
                name="Soulseek"
                {...addressOf(data.url)}
                externalUrl={data.url}
                logo={
                  <SlskdLogo className="service-logo h-10 w-10 flex-shrink-0" />
                }
                detail={{
                  label: intl.formatMessage(messages.downloads),
                  value: data.downloadsPath,
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
                    <span>{intl.formatMessage(messages.addSoulseek)}</span>
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

export default SettingsSoulseek;
