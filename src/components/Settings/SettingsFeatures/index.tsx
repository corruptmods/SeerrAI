import FeatureSwitches, {
  withFeature,
} from '@app/components/Common/FeatureSwitches';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import type { Feature } from '@server/constants/features';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { useSWRConfig } from 'swr';

const messages = defineMessages('components.Settings.SettingsFeatures', {
  features: 'Features',
  description:
    'Optional features of this build. Turning one off here turns it off for everyone. Each person can also turn any of them off for themselves in their own settings.',
  saved: 'Saved.',
  failed: 'Something went wrong while saving.',
});

/**
 * The features turned off for everyone, and a change to one, saved at once.
 * Settings → Features and Settings → Music share it, so the Music switch is
 * the one setting in both places.
 */
export const useFeaturesForEveryone = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { mutate: globalMutate } = useSWRConfig();
  const { data, mutate } = useSWR<{ disabled: string[] }>(
    '/api/v1/settings/features'
  );
  const [saving, setSaving] = useState(false);

  const change = async (feature: Feature, on: boolean) => {
    if (!data) {
      return;
    }
    setSaving(true);
    try {
      const disabled = withFeature(data.disabled, feature, on);
      // Shown straight away; put back if the save fails.
      await mutate({ disabled }, { revalidate: false });
      const response = await axios.post<{ disabled: string[] }>(
        '/api/v1/settings/features',
        {
          disabled,
        }
      );
      await mutate(response.data, { revalidate: false });
      // Everyone's pages read the switches from the public settings.
      await globalMutate('/api/v1/settings/public');
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

  return { disabled: data?.disabled, saving, change };
};

const SettingsFeatures = () => {
  const intl = useIntl();
  const { currentSettings } = useSettings();
  const { disabled, saving, change } = useFeaturesForEveryone();

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.features),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.features)}</h3>
        <p className="description">
          {intl.formatMessage(messages.description)}
        </p>
      </div>
      {disabled ? (
        <div className="section">
          <FeatureSwitches
            disabled={disabled}
            saving={saving}
            aiReady={currentSettings.aiReady}
            // Turned off for everyone, music is not "ready", but its switch
            // has to stay here to turn it back on.
            musicReady={
              currentSettings.musicReady || disabled.includes('music')
            }
            onChange={change}
          />
        </div>
      ) : (
        <LoadingSpinner />
      )}
    </>
  );
};

export default SettingsFeatures;
