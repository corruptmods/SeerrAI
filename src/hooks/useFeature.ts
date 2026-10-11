import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import type { Feature } from '@server/constants/features';
import { featureOn } from '@server/constants/features';

/**
 * A check for any of the fork's optional features, for whoever is signed in:
 * on unless an admin turned it off for everyone, or they did for themselves.
 */
export const useFeatureCheck = (): ((feature: Feature) => boolean) => {
  const { currentSettings } = useSettings();
  const { user } = useUser();
  return (feature) =>
    featureOn(
      feature,
      currentSettings.disabledFeatures,
      user?.settings?.disabledFeatures
    );
};

/** Whether one optional feature is on for whoever is signed in. */
const useFeature = (feature: Feature): boolean => useFeatureCheck()(feature);

export default useFeature;
