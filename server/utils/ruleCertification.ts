/**
 * An age rating an override rule matches: a rating ("PG-13") in one
 * country's system ("US").
 */
export interface RuleCertification {
  country: string;
  certification: string;
}

/**
 * The age ratings a rule matches, as kept on it: "US:G,US:PG,GB:U". Read by
 * the server to match titles and by the rule editor to show them.
 */
export const parseRuleCertifications = (
  value: string | null | undefined
): RuleCertification[] =>
  (value ?? '').split(',').flatMap((entry) => {
    const at = entry.indexOf(':');
    const country = entry.slice(0, Math.max(at, 0)).trim().toUpperCase();
    const certification = entry.slice(at + 1).trim();
    return at > 0 && country && certification
      ? [{ country, certification }]
      : [];
  });

/** The other way: nothing to match is no condition at all. */
export const formatRuleCertifications = (
  entries: RuleCertification[]
): string | null =>
  entries.length > 0
    ? entries
        .map(({ country, certification }) => `${country}:${certification}`)
        .join(',')
    : null;
