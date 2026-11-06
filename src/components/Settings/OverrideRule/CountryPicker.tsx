import type { Region } from '@server/lib/settings';
import sortBy from 'lodash/sortBy';
import { useMemo } from 'react';
import { useIntl } from 'react-intl';
import Select from 'react-select';
import useSWR from 'swr';

type Option = { value: string; label: string };

interface CountryPickerProps {
  inputId: string;
  /** ISO 3166-1 codes, comma-separated. */
  value?: string | null;
  placeholder: string;
  isDisabled?: boolean;
  onChange: (value: string | null) => void;
}

/** Countries for an override rule, by name in the viewer's language. */
const CountryPicker = ({
  inputId,
  value,
  placeholder,
  isDisabled,
  onChange,
}: CountryPickerProps) => {
  const intl = useIntl();
  const { data: regions } = useSWR<Region[]>('/api/v1/regions');

  const nameOf = useMemo(
    () => (code: string) =>
      intl.formatDisplayName(code, { type: 'region', fallback: 'none' }) ??
      regions?.find((region) => region.iso_3166_1 === code)?.english_name ??
      code,
    [intl, regions]
  );

  const options: Option[] = useMemo(
    () =>
      sortBy(
        (regions ?? []).map((region) => ({
          value: region.iso_3166_1,
          label: nameOf(region.iso_3166_1),
        })),
        'label'
      ),
    [regions, nameOf]
  );

  const chosen = (value ?? '')
    .split(',')
    .filter(Boolean)
    .map((code) => ({ value: code, label: nameOf(code) }));

  return (
    <Select<Option, true>
      inputId={inputId}
      className="react-select-container"
      classNamePrefix="react-select"
      isMulti
      isDisabled={isDisabled}
      isLoading={!regions}
      options={options}
      value={chosen}
      placeholder={placeholder}
      onChange={(selected) =>
        onChange(
          selected.length
            ? selected.map((option) => option.value).join(',')
            : null
        )
      }
    />
  );
};

export default CountryPicker;
