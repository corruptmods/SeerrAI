/**
 * An age rating an override rule matches: a rating ("PG-13") in a country's
 * system ("US").
 */
export interface RuleCertification {
  country: string;
  certification: string;
}

/**
 * Parses a rule's stored age ratings ("US:G,US:PG,GB:U"). Used by the server to
 * match titles and the rule editor to show them.
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

/** The inverse; an empty list means no condition. */
export const formatRuleCertifications = (
  entries: RuleCertification[]
): string | null =>
  entries.length > 0
    ? entries
        .map(({ country, certification }) => `${country}:${certification}`)
        .join(',')
    : null;
