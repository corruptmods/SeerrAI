// The fork's optional features. Each is on unless an admin disables it for
// everyone or a user for themselves. Adding one here adds its switch to both
// settings pages.
export const FEATURES = [
  'suggestedForYou',
  'hideWatched',
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

/**
 * How hard the model thinks before answering. "none" asks for no thinking
 * (what OpenAI's newer models want with tools); "lowest" is the least each
 * model accepts; higher costs more and is slower, but answers better.
 */
export const AI_EFFORTS = ['none', 'lowest', 'low', 'medium', 'high'] as const;

export type AiEffort = (typeof AI_EFFORTS)[number];

export const isAiEffort = (value: unknown): value is AiEffort =>
  AI_EFFORTS.includes(value as AiEffort);

/**
 * The efforts worth offering for a model, as Settings → AI lists them, by
 * what the provider is known to take; the server still steps down if a
 * model refuses one. Empty when the model takes no effort at all.
 * - Claude: Low, Medium and High (it has nothing below Low; models before
 *   the 4 family take no effort).
 * - OpenAI itself: none for models that don't reason; o-series from Low;
 *   GPT-5 from Lowest (its "minimal"); newer models from None.
 * - Any other server: every effort, since there's no telling.
 */
export const effortsFor = (
  provider: 'anthropic' | 'openai',
  baseUrl: string,
  model: string
): AiEffort[] => {
  const name = model.trim().toLowerCase();
  if (provider === 'anthropic') {
    return /^claude-(instant|[12](\b|[.-])|3(\b|[.-]))/.test(name)
      ? []
      : ['low', 'medium', 'high'];
  }
  const base = (baseUrl.trim() || 'https://api.openai.com/v1').replace(
    /\/+$/,
    ''
  );
  if (base !== 'https://api.openai.com/v1') {
    return [...AI_EFFORTS];
  }
  if (!name || /^(gpt-4|gpt-3\.5|chatgpt-)/.test(name)) {
    return name ? [] : [...AI_EFFORTS];
  }
  if (/^o\d/.test(name)) {
    return ['low', 'medium', 'high'];
  }
  if (/^gpt-5($|-(?!\d))/.test(name)) {
    return ['lowest', 'low', 'medium', 'high'];
  }
  return ['none', 'low', 'medium', 'high'];
};

/**
 * What a saved effort amounts to among those offered: itself, or the
 * highest offered below it (None and Lowest become the least offered).
 */
export const shownEffort = (
  effort: AiEffort,
  offered: readonly AiEffort[]
): AiEffort | undefined => {
  if (!offered.length || offered.includes(effort)) {
    return offered.length ? effort : undefined;
  }
  const below = AI_EFFORTS.slice(0, AI_EFFORTS.indexOf(effort) + 1)
    .filter((level) => offered.includes(level))
    .pop();
  return below ?? offered[0];
};
