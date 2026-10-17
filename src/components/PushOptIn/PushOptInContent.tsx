import Button from '@app/components/Common/Button';
import type { PushDeviceState } from '@app/hooks/usePushDeviceState';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowUpOnSquareIcon,
  BellAlertIcon,
  BellSlashIcon,
  PlusSmallIcon,
} from '@heroicons/react/24/outline';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.PushOptIn', {
  prompttitle: 'Get notified when it is ready',
  promptdescription:
    'This device is not set up for notifications yet. It only takes a moment.',
  promptaction: 'Enable notifications',
  deniedtitle: 'Notifications are blocked',
  denieddescription:
    'Your browser will not ask again. Allow notifications for this site in your browser settings, then reload this page.',
  blockedtitle: 'This browser will not allow notifications',
  blockeddescription:
    'Some browsers disable push notifications by default. Check your browser privacy settings, or use a different browser.',
  installtitle: 'Add Seerr AI to your home screen',
  installdescription:
    'iPhone and iPad only allow notifications from installed apps.',
  installstepshare: 'Tap the share button in Safari',
  installstepadd: 'Tap add to home screen',
  installstepopen: 'Open Seerr AI from the new icon',
  webviewtitle: 'Open Seerr AI in your browser',
  webviewdescription:
    'Notifications are not available inside this app. Open this page in Safari or Chrome to turn them on.',
  unsupportedtitle: 'Notifications are not available here',
  unsupporteddescription:
    'This browser does not support push notifications. You can still be notified by email or Discord from your notification settings.',
});

interface PushOptInContentProps {
  state: PushDeviceState;
  isSubscribing?: boolean;
  onEnable?: () => void;
}

const PushOptInContent = ({
  state,
  isSubscribing = false,
  onEnable,
}: PushOptInContentProps) => {
  const intl = useIntl();

  if (
    state === 'loading' ||
    state === 'registered' ||
    state === 'disabled' ||
    state === 'unsupported'
  ) {
    return null;
  }

  if (state === 'needs-install') {
    return (
      <div className="flex items-start space-x-3">
        <ArrowUpOnSquareIcon className="h-6 w-6 flex-shrink-0 text-gray-300" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-strong">
            {intl.formatMessage(messages.installtitle)}
          </p>
          <p className="mt-1 text-sm text-gray-400">
            {intl.formatMessage(messages.installdescription)}
          </p>
          <ol className="mt-3 space-y-2 text-sm text-gray-300">
            <li className="flex items-center space-x-2">
              <ArrowUpOnSquareIcon className="h-4 w-4 flex-shrink-0" />
              <span>{intl.formatMessage(messages.installstepshare)}</span>
            </li>
            <li className="flex items-center space-x-2">
              <PlusSmallIcon className="h-4 w-4 flex-shrink-0" />
              <span>{intl.formatMessage(messages.installstepadd)}</span>
            </li>
            <li className="flex items-center space-x-2">
              <BellAlertIcon className="h-4 w-4 flex-shrink-0" />
              <span>{intl.formatMessage(messages.installstepopen)}</span>
            </li>
          </ol>
        </div>
      </div>
    );
  }

  if (state === 'denied' || state === 'blocked-by-browser') {
    const title =
      state === 'denied' ? messages.deniedtitle : messages.blockedtitle;
    const description =
      state === 'denied'
        ? messages.denieddescription
        : messages.blockeddescription;

    return (
      <div className="flex items-start space-x-3">
        <BellSlashIcon className="h-6 w-6 flex-shrink-0 text-yellow-400 light:text-warning-text" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-strong">{intl.formatMessage(title)}</p>
          <p className="mt-1 text-sm text-gray-400">
            {intl.formatMessage(description)}
          </p>
        </div>
      </div>
    );
  }

  if (state === 'webview') {
    return (
      <div className="flex items-start space-x-3">
        <BellSlashIcon className="h-6 w-6 flex-shrink-0 text-gray-300" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-strong">
            {intl.formatMessage(messages.webviewtitle)}
          </p>
          <p className="mt-1 text-sm text-gray-400">
            {intl.formatMessage(messages.webviewdescription)}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start space-x-3">
      <BellAlertIcon className="h-6 w-6 flex-shrink-0 text-indigo-400 light:text-accent-text" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-strong">
          {intl.formatMessage(messages.prompttitle)}
        </p>
        <p className="mt-1 text-sm text-gray-400">
          {intl.formatMessage(messages.promptdescription)}
        </p>
        <Button
          buttonType="primary"
          className="mt-3"
          disabled={isSubscribing}
          onClick={onEnable}
        >
          <BellAlertIcon />
          <span>{intl.formatMessage(messages.promptaction)}</span>
        </Button>
      </div>
    </div>
  );
};

export default PushOptInContent;
