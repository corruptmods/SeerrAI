/**
 * Hours and minutes, rounded to the minute first so 1 h 59 min 40 s reads
 * "2 h 0 min", not "1 h 60 min". Minimum one minute.
 */
export const durationParts = (
  seconds: number
): { hours: number; minutes: number } => {
  const total = Math.max(1, Math.round(seconds / 60));
  return { hours: Math.floor(total / 60), minutes: total % 60 };
};
