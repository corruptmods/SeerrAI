import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import SaveBar from '@app/components/Common/SaveBar';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowDownOnSquareIcon,
  ArrowPathIcon,
} from '@heroicons/react/24/outline';
import type { Region } from '@server/lib/settings';
import axios from 'axios';
import sortBy from 'lodash/sortBy';
import { useEffect, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import Select from 'react-select';
import useSWR, { mutate as globalMutate } from 'swr';

const messages = defineMessages('components.Settings.AnimeSettings', {
  anime: 'Anime',
  description:
    'What counts as anime decides where requests go in Sonarr and Radarr, and what the Anime page lists.',
  leaveOut: 'Leave out anime made in',
  leaveOutTip:
    'Anime-style titles from these countries count as regular. Japanese-language animation is always anime.',
  noCountries: 'No country: anime from everywhere counts',
  saved: 'Anime settings saved.',
  saveFailed: 'Could not save the anime settings.',
  loadFailed: 'The anime settings could not be loaded.',
});

type Option = { value: string; label: string };

/*
 * "Leave out anime made in": the countries whose anime-styled titles do not
 * count as anime unless they are in Japanese (utils/isAnime). Saved as a
 * whole list.
 */
const AnimeSettings = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, error, mutate } = useSWR<{ excludedCountries: string[] }>(
    '/api/v1/settings/anime'
  );
  const { data: regions } = useSWR<Region[]>('/api/v1/regions');
  const [chosen, setChosen] = useState<string[]>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data && !chosen) {
      setChosen(data.excludedCountries);
    }
  }, [data, chosen]);

  const countryName = useMemo(
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
          label: countryName(region.iso_3166_1),
        })),
        'label'
      ),
    [regions, countryName]
  );

  const save = async () => {
    setBusy(true);
    try {
      const saved = await axios.post<{ excludedCountries: string[] }>(
        '/api/v1/settings/anime',
        { excludedCountries: chosen ?? [] }
      );
      setChosen(saved.data.excludedCountries);
      await mutate(saved.data);
      // Pages tell anime apart with the same setting.
      await globalMutate('/api/v1/settings/public');
      addToast(intl.formatMessage(messages.saved), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch {
      addToast(intl.formatMessage(messages.saveFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="mb-6 mt-10">
        <h3 className="heading">{intl.formatMessage(messages.anime)}</h3>
        <p className="description">
          {intl.formatMessage(messages.description)}
        </p>
      </div>
      <div className="section">
        {!chosen ? (
          error ? (
            <Alert type="error" title={intl.formatMessage(messages.loadFailed)}>
              <Button buttonSize="sm" onClick={() => mutate()}>
                <ArrowPathIcon />
                <span>{intl.formatMessage(globalMessages.retry)}</span>
              </Button>
            </Alert>
          ) : (
            <LoadingSpinner />
          )
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="form-row">
              <label htmlFor="animeExcludedCountries" className="text-label">
                {intl.formatMessage(messages.leaveOut)}
                <span className="label-tip">
                  {intl.formatMessage(messages.leaveOutTip)}
                </span>
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <Select<Option, true>
                    inputId="animeExcludedCountries"
                    className="react-select-container"
                    classNamePrefix="react-select"
                    isMulti
                    isDisabled={busy}
                    options={options}
                    placeholder={intl.formatMessage(messages.noCountries)}
                    value={chosen.map((code) => ({
                      value: code,
                      label: countryName(code),
                    }))}
                    onChange={(value) =>
                      setChosen(value.map((option) => option.value))
                    }
                  />
                </div>
              </div>
            </div>
            <SaveBar>
              <div className="flex justify-end">
                <Button buttonType="primary" type="submit" disabled={busy}>
                  <ArrowDownOnSquareIcon />
                  <span>
                    {busy
                      ? intl.formatMessage(globalMessages.saving)
                      : intl.formatMessage(globalMessages.save)}
                  </span>
                </Button>
              </div>
            </SaveBar>
          </form>
        )}
      </div>
    </>
  );
};

export default AnimeSettings;
