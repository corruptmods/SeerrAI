/**
 * Pushover priority choices. 'problems' is high for declined and failed
 * requests and new issues, normal otherwise; the rest apply to everything.
 */
export const PUSHOVER_PRIORITIES = [
  'problems',
  'normal',
  'low',
  'high',
] as const;

export type PushoverPriority = (typeof PUSHOVER_PRIORITIES)[number];
