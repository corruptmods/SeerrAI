/*
 * The fork's optional features. Each is on unless an admin turns it off for
 * everyone, or someone turns it off for themselves. Adding one here adds its
 * switch to both settings pages.
 */
export const FEATURES = [
  'suggestedForYou',
  'deletingSoon',
  'releaseCalendar',
  'arrivalEstimates',
  'whoWatched',
  'newSeasons',
  'watchSuggestions',
  'passkeyPrompt',
  'subtitles',
  'autoFix',
  'music',
  'aiChat',
  'aiReasons',
  'aiPicker',
  'aiRecap',
  'aiDeletionReview',
  'aiIssueTriage',
  'aiLogs',
  'aiBackfill',
  'aiAgent',
] as const;

export type Feature = (typeof FEATURES)[number];

/**
 * The features that use an AI model. They only exist once an admin has set
 * one up (Settings → AI), and each can be turned off like any other.
 */
export const AI_FEATURES = [
  'aiChat',
  'aiReasons',
  'aiPicker',
  'aiRecap',
  'aiDeletionReview',
  'aiIssueTriage',
  'aiLogs',
  'aiBackfill',
  'aiAgent',
] as const satisfies readonly Feature[];

export type AiFeature = (typeof AI_FEATURES)[number];

export const isAiFeature = (value: unknown): value is AiFeature =>
  AI_FEATURES.includes(value as AiFeature);

export const isFeature = (value: unknown): value is Feature =>
  FEATURES.includes(value as Feature);

/** On unless turned off everywhere or by this person. */
export const featureOn = (
  feature: Feature,
  globallyOff: readonly string[] | undefined,
  userOff: readonly string[] | undefined
): boolean =>
  !(globallyOff ?? []).includes(feature) && !(userOff ?? []).includes(feature);
