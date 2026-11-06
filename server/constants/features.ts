// The fork's optional features. Each is on unless an admin disables it for
// everyone or a user for themselves. Adding one here adds its switch to both
// settings pages.
export const FEATURES = [
  'suggestedForYou',
  'deletingSoon',
  'releaseCalendar',
  'arrivalEstimates',
  'whoWatched',
  'newSeasons',
  'watchSuggestions',
  'listRequests',
  'passkeyPrompt',
  'subtitles',
  'autoFix',
  'siri',
  'music',
  'aiChat',
  'aiReasons',
  'aiPicker',
  'aiRecap',
  'aiDeletionReview',
  'aiIssueTriage',
  'aiReports',
  'aiLogs',
  'aiBackfill',
  'aiAgent',
] as const;

export type Feature = (typeof FEATURES)[number];

/**
 * Features using an AI model. They exist only once an admin sets one up
 * (Settings → AI), and each can be turned off like any other.
 */
export const AI_FEATURES = [
  'aiChat',
  'aiReasons',
  'aiPicker',
  'aiRecap',
  'aiDeletionReview',
  'aiIssueTriage',
  'aiReports',
  'aiLogs',
  'aiBackfill',
  'aiAgent',
] as const satisfies readonly Feature[];

export type AiFeature = (typeof AI_FEATURES)[number];

export const isAiFeature = (value: unknown): value is AiFeature =>
  AI_FEATURES.includes(value as AiFeature);

/** On unless disabled globally or by this user. */
export const featureOn = (
  feature: Feature,
  globallyOff: readonly string[] | undefined,
  userOff: readonly string[] | undefined
): boolean =>
  !(globallyOff ?? []).includes(feature) && !(userOff ?? []).includes(feature);
