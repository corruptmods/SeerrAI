import FeatureSwitches, {
  withFeature,
} from '@app/components/Common/FeatureSwitches';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import type { Feature } from '@server/constants/features';
import { hasPermission, Permission } from '@server/lib/permissions';
import axios from 'axios';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.UserProfile.UserSettings.UserFeatureSettings',
  {
    features: 'Features',
    description:
      'Turn off anything you would rather not see. This only changes things for you.',
    saved: 'Saved.',
    failed: 'Something went wrong while saving.',
  }
);

const UserFeatureSettings = () => {
  const intl = useIntl();
  const router = useRouter();
  const { addToast } = useToasts();
  const { currentSettings } = useSettings();
  const { user: currentUser, revalidate: revalidateCurrentUser } = useUser();
  const { user, revalidate } = useUser({ id: Number(router.query.userId) });
  // Admin tools are only listed for someone who can use them.
  const can = (permission: Permission) =>
    hasPermission(permission, user?.permissions ?? 0);
  const adminTools: Feature[] = [
    ...(can(Permission.MANAGE_REQUESTS) ? [] : ['aiDeletionReview' as const]),
    ...(can(Permission.MANAGE_ISSUES) ? [] : ['aiIssueTriage' as const]),
    ...(can(Permission.ADMIN)
      ? []
      : ['aiLogs' as const, 'aiBackfill' as const, 'aiAgent' as const]),
  ];
  const [saving, setSaving] = useState(false);

  const key = user ? `/api/v1/user/${user.id}/settings/features` : null;
  const { data, mutate } = useSWR<{ disabled: string[] }>(key);

  const change = async (feature: Feature, on: boolean) => {
    if (!data || !key) {
      return;
    }
    setSaving(true);
    try {
      const disabled = withFeature(data.disabled, feature, on);
      // Shown straight away; put back if the save fails.
      await mutate({ disabled }, { revalidate: false });
      const response = await axios.post<{ disabled: string[] }>(key, {
        disabled,
      });
      await mutate(response.data, { revalidate: false });
      // Pages read the switches from the signed-in user.
      await revalidate();
      if (currentUser?.id === user?.id) {
        await revalidateCurrentUser();
      }
      addToast(intl.formatMessage(messages.saved), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch {
      await mutate(data, { revalidate: false });
      addToast(intl.formatMessage(messages.failed), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.features),
          intl.formatMessage(globalMessages.usersettings),
          user?.displayName,
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.features)}</h3>
        <p className="description">
          {intl.formatMessage(messages.description)}
        </p>
      </div>
      {data ? (
        <div className="section">
          <FeatureSwitches
            disabled={data.disabled}
            saving={saving}
            lockedOff={currentSettings.disabledFeatures}
            aiReady={currentSettings.aiReady}
            musicReady={currentSettings.musicReady}
            forPerson
            hidden={adminTools}
            onChange={change}
          />
        </div>
      ) : (
        <LoadingSpinner />
      )}
    </>
  );
};

export default UserFeatureSettings;
