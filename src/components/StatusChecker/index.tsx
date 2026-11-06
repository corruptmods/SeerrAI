import Modal from '@app/components/Common/Modal';
import { useNotice } from '@app/context/NoticeQueue';
import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import type { StatusResponse } from '@server/interfaces/api/settingsInterfaces';
import { Fragment } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.StatusChecker', {
  appUpdated: '{applicationTitle} Updated',
  appUpdatedDescription: 'Reload to use the new version.',
  reloadApp: 'Reload {applicationTitle}',
});

const StatusChecker = () => {
  const intl = useIntl();
  const settings = useSettings();
  const { data, error } = useSWR<StatusResponse>(
    '/api/v1/status?checkUpdateAvailable=false',
    {
      refreshInterval: 60 * 1000,
    }
  );
  const wanted = !!data && data.commitTag !== process.env.commitTag;
  // Loading counts as hidden: updates are rare and jump the queue anyway.
  const myTurn = useNotice('appUpdated', wanted ? 'show' : 'hide');

  if (!data && !error) {
    return null;
  }

  if (!data) {
    return null;
  }

  return (
    <Transition
      as={Fragment}
      enter="transition-opacity duration-300"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition-opacity duration-300"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
      appear
      show={wanted && myTurn}
    >
      <Modal
        title={intl.formatMessage(messages.appUpdated, {
          applicationTitle: settings.currentSettings.applicationTitle,
        })}
        onOk={() => location.reload()}
        okText={intl.formatMessage(messages.reloadApp, {
          applicationTitle: settings.currentSettings.applicationTitle,
        })}
        backgroundClickable={false}
      >
        {intl.formatMessage(messages.appUpdatedDescription)}
      </Modal>
    </Transition>
  );
};

export default StatusChecker;
