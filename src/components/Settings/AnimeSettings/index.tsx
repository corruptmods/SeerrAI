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
import type { AnimeMode, Region } from '@server/lib/settings';
import axios from 'axios';
import sortBy from 'lodash/sortBy';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import Select from 'react-select';
import useSWR, { mutate as globalMutate } from 'swr';

const messages = defineMessages('components.Settings.AnimeSettings', {
  anime: 'Anime',
  description:
    'What counts as anime decides where requests go in Sonarr and Radarr, and what the Anime page lists.',
  mode: 'Anime handling',
  modeTip:
    'Auto turns it on while a Sonarr or Radarr server has an anime root folder, anime quality profile or anime tags of its own. Off sends everything with the standard settings and hides the anime choices.',
  modeAuto: 'Auto',
  modeOn: 'On',
  modeOff: 'Off',
  nowOnLibrary: 'On now: a Sonarr or Radarr server has an anime library.',
  nowOffNoLibrary:
    'Off now: no Sonarr or Radarr server has an anime root folder, quality profile or tags of its own.',
  nowOn: 'On, whatever the servers have.',
  nowOff: 'Off, whatever the servers have.',
  check: 'Anime Check',
  checkTip:
    'Checks daily for titles Sonarr or Radarr treat differently from Seerr AI. It never runs while anime is off.',
  leaveOut: 'Leave out anime made in',
  leaveOutTip:
    'Anime-style titles from these countries count as regular. Japanese-language animation is always anime.',
  noCountries: 'No country: anime from everywhere counts',
  saved: 'Anime settings saved.',
  saveFailed: 'Could not save the anime settings.',
  loadFailed: 'The anime settings could not be loaded.',
});

type Option = { value: string; label: string };

/** GET and POST /settings/anime. */
interface AnimeSettingsResponse {
  mode: AnimeMode;
  /** Whether anime handling is on now. */
  enabled: boolean;
  /** Whether some Sonarr or Radarr has an anime library (what auto follows). */
  librarySetUp: boolean;
  /** Whether Anime Check runs while anime is on. */
  check: boolean;
  excludedCountries: string[];
}

/*
 * Anime handling on, off or auto (on while an anime library is set up), Anime
 * Check's own switch, and countries whose anime-style titles count as regular
 * unless in Japanese (utils/isAnime). Saved together.
 */
const AnimeSettings = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, error, mutate } = useSWR<AnimeSettingsResponse>(
    '/api/v1/settings/anime'
  );
  const { data: regions } = useSWR<Region[]>('/api/v1/regions');
  const [chosen, setChosen] = useState<string[]>();
  const [mode, setMode] = useState<AnimeMode>();
  const [check, setCheck] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data && !chosen) {
      setChosen(data.excludedCountries);
      setMode(data.mode);
      setCheck(data.check);
    }
  }, [data, chosen]);

  const countryName = useCallback(
    (code: string) =>
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
      const saved = await axios.post<AnimeSettingsResponse>(
        '/api/v1/settings/anime',
        { mode, check, excludedCountries: chosen ?? [] }
      );
      setChosen(saved.data.excludedCountries);
      setMode(saved.data.mode);
      setCheck(saved.data.check);
      await mutate(saved.data);
      // Public settings carry the switch and the list for the pages.
      await globalMutate('/api/v1/settings/public');
      await globalMutate('/api/v1/settings/anime-check');
      await globalMutate('/api/v1/settings/jobs');
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
        {!chosen || !mode || !data ? (
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
              <label htmlFor="animeMode" className="text-label">
                {intl.formatMessage(messages.mode)}
                <span className="label-tip">
                  {intl.formatMessage(messages.modeTip)}
                </span>
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <select
                    id="animeMode"
                    name="animeMode"
                    value={mode}
                    disabled={busy}
                    onChange={(e) => setMode(e.target.value as AnimeMode)}
                  >
                    <option value="auto">
                      {intl.formatMessage(messages.modeAuto)}
                    </option>
                    <option value="on">
                      {intl.formatMessage(messages.modeOn)}
                    </option>
                    <option value="off">
                      {intl.formatMessage(messages.modeOff)}
                    </option>
                  </select>
                </div>
                <p className="mt-2 text-sm text-gray-400" aria-live="polite">
                  {intl.formatMessage(
                    mode === 'auto'
                      ? data.librarySetUp
                        ? messages.nowOnLibrary
                        : messages.nowOffNoLibrary
                      : mode === 'on'
                        ? messages.nowOn
                        : messages.nowOff
                  )}
                </p>
              </div>
            </div>
            <div className="form-row">
              <label htmlFor="animeCheck" className="checkbox-label">
                {intl.formatMessage(messages.check)}
                <span className="label-tip">
                  {intl.formatMessage(messages.checkTip)}
                </span>
              </label>
              <div className="form-input-area">
                <input
                  type="checkbox"
                  id="animeCheck"
                  name="animeCheck"
                  checked={check}
                  disabled={busy}
                  onChange={(e) => setCheck(e.target.checked)}
                />
              </div>
            </div>
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
