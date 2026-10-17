import { SmallLoadingSpinner } from '@app/components/Common/LoadingSpinner';
import defineMessages from '@app/utils/defineMessages';
import type { RuleCertification } from '@server/utils/ruleCertification';
import {
  formatRuleCertifications,
  parseRuleCertifications,
} from '@server/utils/ruleCertification';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.Settings.OverrideRule.CertificationPicker',
  {
    fallback: '{country}, for titles with no {region} rating',
    noRatings: 'TMDB has no age ratings for {country}.',
    loadFailed: 'The age ratings could not be loaded.',
  }
);

interface CertificationsResponse {
  certifications: Record<
    string,
    { certification: string; meaning?: string; order?: number }[]
  >;
}

interface CertificationPickerProps {
  /** Film ratings for a Radarr rule, TV ones for a Sonarr rule. */
  type: 'movie' | 'tv';
  /** The country ratings are read for: the server's Discover region. */
  region: string;
  value?: string | null;
  onChange: (value: string | null) => void;
  isDisabled?: boolean;
  /** The id of the label naming the whole picker. */
  labelledBy?: string;
}

/**
 * Picks the age ratings an override rule matches: the Discover region's,
 * then the US ones a title without a rating there is matched by. A rating
 * already on the rule for any other country stays listed, so it can be
 * taken off.
 */
const CertificationPicker = ({
  type,
  region,
  value,
  onChange,
  isDisabled,
  labelledBy,
}: CertificationPickerProps) => {
  const intl = useIntl();
  const { data, error } = useSWR<CertificationsResponse>(
    `/api/v1/certifications/${type}`
  );
  const selected = parseRuleCertifications(value);

  if (error) {
    return (
      <div className="text-sm text-danger-text">
        {intl.formatMessage(messages.loadFailed)}
      </div>
    );
  }

  if (!data) {
    return <SmallLoadingSpinner />;
  }

  const countryName = (code: string) =>
    intl.formatDisplayName(code, { type: 'region', fallback: 'none' }) ?? code;

  const countries = [
    ...new Set([region, 'US', ...selected.map((entry) => entry.country)]),
  ];

  const isSelected = (country: string, certification: string) =>
    selected.some(
      (entry) =>
        entry.country === country && entry.certification === certification
    );

  const toggle = (entry: RuleCertification) =>
    onChange(
      formatRuleCertifications(
        isSelected(entry.country, entry.certification)
          ? selected.filter(
              (s) =>
                s.country !== entry.country ||
                s.certification !== entry.certification
            )
          : [...selected, entry]
      )
    );

  return (
    <div className="space-y-3" role="group" aria-labelledby={labelledBy}>
      {countries.map((country) => {
        const ratings = [...(data.certifications[country] ?? [])].sort(
          (a, b) =>
            (a.order ?? 0) - (b.order ?? 0) ||
            a.certification.localeCompare(b.certification)
        );
        // Kept even if TMDB no longer lists them, so they can be removed.
        const kept = selected
          .filter(
            (entry) =>
              entry.country === country &&
              !ratings.some((r) => r.certification === entry.certification)
          )
          .map((entry) => ({ certification: entry.certification }));
        const shown: { certification: string; meaning?: string }[] = [
          ...ratings,
          ...kept,
        ];

        // The region is always listed, to say so when TMDB has no ratings
        // for it (its titles then go by their US rating). Other countries
        // only when there is something to pick.
        if (shown.length === 0 && country !== region) {
          return null;
        }

        const heading =
          country === 'US' && region !== 'US'
            ? intl.formatMessage(messages.fallback, {
                country: countryName('US'),
                region: countryName(region),
              })
            : countryName(country);

        return (
          <div key={country} role="group" aria-label={heading}>
            <div className="mb-1 text-sm font-medium text-gray-400">
              {heading}
            </div>
            {shown.length === 0 ? (
              <p className="text-sm text-gray-500">
                {intl.formatMessage(messages.noRatings, {
                  country: countryName(country),
                })}
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {shown.map(({ certification, meaning }) => {
                  const on = isSelected(country, certification);
                  return (
                    <button
                      key={certification}
                      type="button"
                      title={meaning}
                      aria-pressed={on}
                      disabled={isDisabled}
                      onClick={() => toggle({ country, certification })}
                      className={`rounded-full px-3 py-1 text-sm font-medium transition-colors disabled:opacity-50 ${
                        on
                          ? 'bg-accent text-on-accent hover:bg-indigo-700'
                          : 'bg-gray-700 text-gray-200 hover:bg-gray-600'
                      }`}
                    >
                      {certification}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default CertificationPicker;
