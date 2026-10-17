import BazarrLogo from '@app/assets/services/bazarr.svg';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import type { ShownBazarr } from '@app/components/Settings/BazarrModal';
import BazarrModal from '@app/components/Settings/BazarrModal';
import ServerInstance from '@app/components/Settings/ServerInstance';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { PlusIcon } from '@heroicons/react/24/solid';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate as globalMutate } from 'swr';

const messages = defineMessages('components.Settings.SettingsBazarr', {
  title: 'Bazarr',
  description:
    'Link Bazarr to show each title’s subtitles on its page, and to search, replace, delete or transcribe them from there. Bazarr does the work; Seerr AI asks it.',
  addBazarr: 'Add Bazarr',
  subtitles: 'Subtitles',
  onTitlePages: 'On title pages',
  deleteBazarr: 'Disconnect Bazarr',
  deleteBazarrConfirm:
    'Disconnect Bazarr? Title pages stop showing subtitles until it is added again.',
  deleteFailed: 'Could not disconnect Bazarr.',
});

/*
 * Bazarr, laid out like Maintainerr and the download clients: its tile with
 * Edit and Delete once it is set up, a dashed tile to add it before.
 */
const SettingsBazarr = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, error, mutate } = useSWR<ShownBazarr>(
    '/api/v1/settings/bazarr'
  );
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const configured = !!data?.hostname && !!data.hasApiKey;

  // Title pages read whether Bazarr is set up from the public settings.
  const refresh = () => {
    void mutate();
    void globalMutate('/api/v1/settings/public');
  };

  const disconnect = async () => {
    try {
      await axios.delete('/api/v1/settings/bazarr');
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
        <BazarrModal
          bazarr={configured ? (data ?? null) : null}
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
          title={intl.formatMessage(messages.deleteBazarr)}
        >
          {intl.formatMessage(messages.deleteBazarrConfirm)}
        </Modal>
      </Transition>
      <div className="section">
        {!data && !error && <LoadingSpinner />}
        {data && !error && (
          <ul className="grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-2 xl:grid-cols-3">
            {configured ? (
              <ServerInstance
                name="Bazarr"
                hostname={data.hostname}
                port={data.port}
                isSSL={data.useSsl}
                logo={
                  <BazarrLogo className="service-logo h-10 w-10 flex-shrink-0" />
                }
                detail={{
                  label: intl.formatMessage(messages.subtitles),
                  value: intl.formatMessage(messages.onTitlePages),
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
                    <span>{intl.formatMessage(messages.addBazarr)}</span>
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

export default SettingsBazarr;
