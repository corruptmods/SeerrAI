import type { Feature } from '@server/constants/features';
import { featureOn, FEATURES } from '@server/constants/features';
import type { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';

/**
 * Whether a feature is on globally or, given a user, for them. Off globally
 * wins.
 */
export const featureEnabled = (feature: Feature, user?: User | null) =>
  featureOn(
    feature,
    getSettings().main.disabledFeatures,
    user?.settings?.disabledFeatures
  );

/** Known feature names only, each once, in a stable order. */
export const cleanFeatureList = (value: unknown): Feature[] | undefined =>
  Array.isArray(value)
    ? FEATURES.filter((feature) => value.includes(feature))
    : undefined;
