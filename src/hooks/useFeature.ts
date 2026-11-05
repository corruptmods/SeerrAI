import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import type { Feature } from '@server/constants/features';
import { featureOn } from '@server/constants/features';

/**
 * Checks the fork's optional features for the signed-in user: on unless
 * disabled globally or by the user. Music also needs Lidarr set up.
 */
export const useFeatureCheck = (): ((feature: Feature) => boolean) => {
  const { currentSettings } = useSettings();
  const { user } = useUser();
  return (feature) =>
    (feature !== 'music' || currentSettings.musicReady) &&
    featureOn(
      feature,
      currentSettings.disabledFeatures,
      user?.settings?.disabledFeatures
    );
};

/** Whether an optional feature is on for the signed-in user. */
const useFeature = (feature: Feature): boolean => useFeatureCheck()(feature);

export default useFeature;
