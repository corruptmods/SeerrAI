import FeatureSwitches, {
  withFeature,
} from '@app/components/Common/FeatureSwitches';
import { NOT_ON_FEATURES_PAGE } from '@app/components/Common/FeatureSwitches/shown';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import SiriShortcut from '@app/components/Settings/SettingsFeatures/SiriShortcut';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ArrowRightIcon } from '@heroicons/react/24/outline';
import type { Feature } from '@server/constants/features';
import axios from 'axios';
import Link from 'next/link';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { useSWRConfig } from 'swr';

const messages = defineMessages('components.Settings.SettingsFeatures', {
  features: 'Features',
  description:
    'Off here is off for everyone. People can also turn features off for themselves.',
  saved: 'Saved.',
  failed: 'Something went wrong while saving.',
  musicOwnPage: 'Music has its own page',
});

/**
 * The features turned off for everyone, and a change to one, saved at once.
 * Settings → Features switches all but music with it, and Settings → Music
 * switches music, so both change the one list.
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
            musicReady={currentSettings.musicReady}
            // Music is switched on its own page, which this points to.
            hidden={NOT_ON_FEATURES_PAGE}
            instead={{
              music: (
                <p className="sm:col-span-3">
                  <Link
                    href="/settings/music"
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-indigo-400 hover:text-indigo-300 hover:underline light:text-accent-text light:hover:text-accent-text"
                  >
                    {intl.formatMessage(messages.musicOwnPage)}
                    <ArrowRightIcon className="h-4 w-4" />
                  </Link>
                </p>
              ),
            }}
            onChange={change}
          />
        </div>
      ) : (
        <LoadingSpinner />
      )}
      <SiriShortcut />
    </>
  );
};

export default SettingsFeatures;
