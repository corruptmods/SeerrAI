import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import SaveBar from '@app/components/Common/SaveBar';
import NotificationTypeSelector, {
  WEB_PUSH_STARTING_TYPES,
} from '@app/components/NotificationTypeSelector';
import { dismissPushOptIn } from '@app/components/PushOptIn/PushOptInBanner';
import { pushOptInMessages } from '@app/components/PushOptIn/PushOptInContent';
import DeviceItem from '@app/components/UserProfile/UserSettings/UserNotificationSettings/UserNotificationsWebPush/DeviceItem';
import type { PushDeviceState } from '@app/hooks/usePushDeviceState';
import usePushDeviceState from '@app/hooks/usePushDeviceState';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { getPushSubscription } from '@app/utils/pushSubscriptionHelpers';
import { ArrowDownOnSquareIcon } from '@heroicons/react/24/outline';
import type { UserSettingsNotificationsResponse } from '@server/interfaces/api/userSettingsInterfaces';
import axios from 'axios';
import { Form, Formik } from 'formik';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useState } from 'react';
import type { MessageDescriptor } from 'react-intl';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';

const messages = defineMessages(
  'components.UserProfile.UserSettings.UserNotificationSettings.UserNotificationsWebPush',
  {
    webpushsettingssaved: 'Web push notification settings saved successfully!',
    webpushsettingsfailed: 'Web push notification settings failed to save.',
    enablewebpush: 'Enable web push',
    thisdevice:
      'For this device only. Your other devices are under Manage Devices.',
    managedevices: 'Manage Devices',
    type: 'type',
    created: 'Created',
    device: 'Device',
    subscriptiondeleted: 'Subscription deleted.',
    subscriptiondeleteerror:
      'Something went wrong while deleting the user subscription.',
    nodevicestoshow: 'You have no web push subscriptions to show.',
    webpushhasbeenenabled: 'Web push has been enabled.',
    webpushhasbeendisabled: 'Web push has been disabled.',
    enablingwebpusherror: 'Something went wrong while enabling web push.',
    disablingwebpusherror: 'Something went wrong while disabling web push.',
  }
);

/** Why this device's switch is unavailable, per state. */
const UNAVAILABLE: Partial<Record<PushDeviceState, MessageDescriptor>> = {
  denied: pushOptInMessages.denieddescription,
  'blocked-by-browser': pushOptInMessages.blockeddescription,
  'needs-install': pushOptInMessages.installdescription,
  webview: pushOptInMessages.webviewdescription,
  unsupported: pushOptInMessages.unsupporteddescription,
};

const UserWebPushSettings = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const router = useRouter();
  const { user } = useUser({ id: Number(router.query.userId) });
  const { user: signedIn } = useUser();
  const device = usePushDeviceState();
  const [switching, setSwitching] = useState(false);
  const [subEndpoint, setSubEndpoint] = useState<string | null>(null);
  // Only on one's own settings, and not while web push is disabled globally.
  const showSwitch =
    !!user && user.id === signedIn?.id && device.state !== 'disabled';
  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<UserSettingsNotificationsResponse>(
    user ? `/api/v1/user/${user?.id}/settings/notifications` : null
  );
  const { data: dataDevices, mutate: revalidateDevices } = useSWR<
    {
      endpoint: string;
      p256dh: string;
      auth: string;
      userAgent: string;
      createdAt: Date;
    }[]
  >(user ? `/api/v1/user/${user.id}/pushSubscriptions` : null, {
    revalidateOnMount: true,
  });

  // Runs directly in the click so the browser's permission prompt can open.
  const switchThisDevice = async (on: boolean) => {
    if (!user) {
      return;
    }
    setSwitching(true);
    if (!on) {
      // Dismiss first so the opt-in banner doesn't appear.
      dismissPushOptIn(user.id);
    }
    const done = on ? await device.subscribe() : await device.unsubscribe();
    setSwitching(false);

    addToast(
      intl.formatMessage(
        done
          ? on
            ? messages.webpushhasbeenenabled
            : messages.webpushhasbeendisabled
          : on
            ? messages.enablingwebpusherror
            : messages.disablingwebpusherror
      ),
      { appearance: done ? 'success' : 'error', autoDismiss: true }
    );
  };

  const deletePushSubscriptionFromBackend = async (endpoint: string) => {
    try {
      await axios.delete(
        `/api/v1/user/${user?.id}/pushSubscription/${encodeURIComponent(
          endpoint
        )}`
      );

      addToast(intl.formatMessage(messages.subscriptiondeleted), {
        autoDismiss: true,
        appearance: 'success',
      });
    } catch {
      addToast(intl.formatMessage(messages.subscriptiondeleteerror), {
        autoDismiss: true,
        appearance: 'error',
      });
    } finally {
      revalidateDevices();
    }
  };

  // This browser's subscription, to mark it in the list.
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      return;
    }
    let current = true;
    getPushSubscription()
      .then(({ subscription }) => {
        if (current) {
          setSubEndpoint(subscription?.endpoint ?? null);
        }
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [device.state]);

  const sortedDevices = useMemo(() => {
    if (!dataDevices || !subEndpoint) {
      return dataDevices;
    }

    return [...dataDevices].sort((a, b) => {
      if (a.endpoint === subEndpoint) {
        return -1;
      }
      if (b.endpoint === subEndpoint) {
        return 1;
      }

      const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return dateB - dateA;
    });
  }, [dataDevices, subEndpoint]);

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  return (
    <>
      <Formik
        initialValues={{
          types: data?.notificationTypes.webpush ?? WEB_PUSH_STARTING_TYPES,
        }}
        enableReinitialize
        onSubmit={async (values) => {
          try {
            await axios.post(
              `/api/v1/user/${user?.id}/settings/notifications`,
              {
                pgpKey: data?.pgpKey,
                discordIds: data?.discordIds,
                pushbulletAccessToken: data?.pushbulletAccessToken,
                pushoverApplicationToken: data?.pushoverApplicationToken,
                pushoverUserKey: data?.pushoverUserKey,
                telegramChatId: data?.telegramChatId,
                telegramSendSilently: data?.telegramSendSilently,
                notificationTypes: {
                  webpush: values.types,
                },
              }
            );
            mutate('/api/v1/settings/public');
            addToast(intl.formatMessage(messages.webpushsettingssaved), {
              appearance: 'success',
              autoDismiss: true,
            });
          } catch {
            addToast(intl.formatMessage(messages.webpushsettingsfailed), {
              appearance: 'error',
              autoDismiss: true,
            });
          } finally {
            revalidate();
          }
        }}
      >
        {({
          errors,
          touched,
          isSubmitting,
          isValid,
          values,
          setFieldValue,
          setFieldTouched,
        }) => {
          return (
            <Form className="section">
              {showSwitch && (
                <div className="form-row">
                  <label htmlFor="thisDevice" className="checkbox-label">
                    {intl.formatMessage(messages.enablewebpush)}
                    <span className="label-tip">
                      {intl.formatMessage(
                        UNAVAILABLE[device.state] ?? messages.thisdevice
                      )}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <input
                      type="checkbox"
                      id="thisDevice"
                      checked={device.state === 'registered'}
                      disabled={
                        switching ||
                        (device.state !== 'registered' &&
                          device.state !== 'prompt')
                      }
                      onChange={(e) => switchThisDevice(e.target.checked)}
                    />
                  </div>
                </div>
              )}
              <NotificationTypeSelector
                user={user}
                currentTypes={values.types}
                onUpdate={(newTypes) => {
                  setFieldValue('types', newTypes);
                  setFieldTouched('types');
                }}
                error={
                  errors.types && touched.types
                    ? (errors.types as string)
                    : undefined
                }
              />
              <SaveBar>
                <div className="flex justify-end">
                  <span className="ml-3 inline-flex rounded-md shadow-sm">
                    <Button
                      buttonType="primary"
                      type="submit"
                      disabled={isSubmitting || !isValid}
                    >
                      <ArrowDownOnSquareIcon />
                      <span>
                        {isSubmitting
                          ? intl.formatMessage(globalMessages.saving)
                          : intl.formatMessage(globalMessages.save)}
                      </span>
                    </Button>
                  </span>
                </div>
              </SaveBar>
            </Form>
          );
        }}
      </Formik>
      <div className="mb-6 mt-10">
        <h3 className="heading">
          {intl.formatMessage(messages.managedevices)}
        </h3>
        <div className="section">
          {sortedDevices?.length ? (
            sortedDevices.map((device) => (
              <div className="py-2" key={`device-list-${device.endpoint}`}>
                <DeviceItem
                  deletePushSubscriptionFromBackend={
                    deletePushSubscriptionFromBackend
                  }
                  device={device}
                  subEndpoint={subEndpoint}
                />
              </div>
            ))
          ) : (
            <>
              <Alert
                title={intl.formatMessage(messages.nodevicestoshow)}
                type="info"
              />
            </>
          )}
        </div>
      </div>
    </>
  );
};

export default UserWebPushSettings;
