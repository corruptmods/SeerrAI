import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import SaveBar from '@app/components/Common/SaveBar';
import AdvancedSection from '@app/components/Settings/AdvancedSection';
import BlockedGroups from '@app/components/Settings/SettingsBackfill/BlockedGroups';
import DownloadCheck from '@app/components/Settings/SettingsBackfill/DownloadCheck';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownOnSquareIcon } from '@heroicons/react/24/outline';
import type { BackfillSettings } from '@server/lib/settings';
import axios from 'axios';
import { Field, Form, Formik } from 'formik';
import Link from 'next/link';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Settings.SettingsBackfill', {
  backfill: 'Backfill',
  description:
    'Finds what Sonarr couldn’t by searching Prowlarr under every name, checks each file, and downloads only what you approve.',
  enabled: 'Enable Backfill',
  enabledTip: 'Scans run on a schedule (Settings → Jobs & Cache).',
  prowlarr: 'Prowlarr',
  prowlarrAt:
    'Searches Prowlarr at {address}. <ServicesLink>Change it in Services</ServicesLink>.',
  prowlarrMissing:
    'Backfill needs Prowlarr. <ServicesLink>Set it up in Settings → Services</ServicesLink> first.',
  downloads: 'Downloads',
  torrentClient: 'Torrent packs go to',
  usenetClient: 'Usenet packs go to',
  noClient: 'Not used',
  noClients: 'Add a download client under Services → Download clients first.',
  category: 'Category',
  categoryTip:
    'Keeps Backfill’s downloads apart, so Sonarr and Radarr don’t import them on their own.',
  categoryTipMusic:
    'Keeps Backfill’s downloads apart, so Sonarr, Radarr and Lidarr don’t import them on their own.',
  when: 'When a title is stuck',
  includeMovies: 'Movies too',
  includeMoviesTip: 'Also follow movies Radarr couldn’t find.',
  includeMusic: 'Music too',
  includeMusicTip: 'Also follow albums Lidarr couldn’t find.',
  stuckAfterHours: 'Hours since Sonarr’s or Radarr’s last search',
  includeCutoffUnmet: 'Treat files below the cutoff as gaps',
  includeCutoffUnmetTip: 'Off: packs that only upgrade files aren’t offered.',
  includeSpecials: 'Include specials (season 0)',
  searchesPerScan: 'Titles searched per scan',
  researchAfterDays: 'Days before searching a title again',
  approval: 'Approval',
  autoApprove: 'Approve some packs automatically',
  autoApproveTip:
    'Packs that only fill gaps, within this score and size. Anything else waits for an admin.',
  replaceFailed: 'Replace failed downloads',
  replaceFailedTip:
    'When a download fails or stalls, the next pack within the score and size below replaces it.',
  minScore: 'Minimum score',
  maxSizeGb: 'Largest download (GB)',
  safety: 'Limits',
  maxActiveJobs: 'Downloads running at once, per client',
  maxActiveJobsTip:
    'Counted for torrents and Usenet apart. A download being imported does not count.',
  stallHours: 'Give up on a torrent after this many hours without progress',
  stallHoursTip:
    'Also when part of it is on no one’s computer for that long, so it can’t finish. Paused or queued time doesn’t count. 0 waits forever.',
  slowHours: 'Give up on a torrent that would take longer than this many hours',
  slowHoursTip:
    'Judged by its speed over the last four hours. Paused or queued time doesn’t count. 0 never gives up.',
  minFreeSpaceGb: 'Keep free on the series’ disk (GB)',
  stepDown: 'Step down a quality preset',
  stepDownTip:
    'A title on one of Seerr AI’s quality presets (Settings → Quality) that nothing is grabbed for moves to the next looser preset, then back once something is.',
  stepDownDays: 'Days before it steps down',
  historyDays: 'Days to keep finished downloads',
  historyDaysTip:
    'Older ones are removed nightly; packs you turned down are kept. 0 keeps everything.',
  saved: 'Backfill settings saved.',
  saveFailed: 'Backfill settings could not be saved.',
  loadFailed: 'Backfill settings could not be loaded.',
  openBackfill: 'Open Backfill',
  agent: 'Admin agent',
  agentTip:
    'An AI that digs further when Backfill finds nothing (needs AI and Admin Agent on). It replaces or deletes nothing without your approval.',
  agentAutoRun: 'Step in on its own',
  agentAutoRunTip:
    'Steps in when Backfill finds nothing for a requested or reported title. Off: only when an admin asks.',
  agentMaxAutoRunsPerDay: 'Times it may start on its own in a day',
  agentMaxGrabsPerDay: 'Downloads it may start in a day',
  agentMaxSizeGb: 'Largest download it may start (GB)',
  agentMaxSteps: 'Steps it may take in one go',
  agentAutoContinue: 'Times it carries on by itself',
  agentAutoContinueTip:
    'Extra goes it takes on its own when out of steps, if the last started a download. 0 waits for you.',
  agentKeepDays: 'Days to keep finished conversations',
  agentKeepDaysTip:
    'Older ones are deleted; 0 keeps them. Downloads are never touched.',
  agentInstructions: 'Standing instructions',
  agentInstructionsTip:
    'Standing rules in your words, such as “prefer usenet” or “nothing under 720p”.',
  agentMaxStepsTip:
    'Each decision it makes is one step. Fewer steps cost less.',
});

interface Shown extends Omit<BackfillSettings, 'prowlarr'> {
  prowlarr: BackfillSettings['prowlarr'] & { hasApiKey: boolean };
  torrentClients: { id: number; name: string }[];
  usenetClients: { id: number; name: string }[];
}

/**
 * The client chosen, or "Not used" for none, or for one that has since been
 * removed, so the form can still be saved.
 */
const chosen = (id: number | null, clients: { id: number }[]): number | '' =>
  id !== null && clients.some((c) => c.id === id) ? id : '';

const SettingsBackfill = () => {
  const intl = useIntl();
  const { currentSettings } = useSettings();
  const musicReady = !!currentSettings.musicReady;
  const { addToast } = useToasts();
  const { data, error, mutate } = useSWR<Shown>('/api/v1/settings/backfill');

  if (!data && !error) return <LoadingSpinner />;
  if (!data) {
    return (
      <Alert type="error" title={intl.formatMessage(messages.loadFailed)} />
    );
  }

  const noClients = !data.torrentClients.length && !data.usenetClients.length;
  // Prowlarr is set up in Services; here, only whether it is.
  const prowlarrReady = !!data.prowlarr.hostname && data.prowlarr.hasApiKey;
  const prowlarrAddress = `${data.prowlarr.useSsl ? 'https' : 'http'}://${
    data.prowlarr.hostname
  }:${data.prowlarr.port}${data.prowlarr.urlBase}`;

  return (
    <>
      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.backfill)}</h3>
        <p className="description">
          {intl.formatMessage(messages.description)}{' '}
          <Link
            href="/backfill"
            className="text-indigo-400 hover:underline light:text-accent-text"
          >
            {intl.formatMessage(messages.openBackfill)}
          </Link>
        </p>
      </div>
      <Formik
        initialValues={{
          ...data,
          torrentClientId: chosen(data.torrentClientId, data.torrentClients),
          usenetClientId: chosen(data.usenetClientId, data.usenetClients),
        }}
        enableReinitialize
        onSubmit={async (values) => {
          try {
            await axios.put('/api/v1/settings/backfill', {
              enabled: values.enabled,
              torrentClientId:
                values.torrentClientId === ''
                  ? null
                  : Number(values.torrentClientId),
              usenetClientId:
                values.usenetClientId === ''
                  ? null
                  : Number(values.usenetClientId),
              category: values.category,
              includeMovies: values.includeMovies,
              includeMusic: values.includeMusic,
              stuckAfterHours: Number(values.stuckAfterHours),
              includeCutoffUnmet: values.includeCutoffUnmet,
              includeSpecials: values.includeSpecials,
              searchesPerScan: Number(values.searchesPerScan),
              researchAfterDays: Number(values.researchAfterDays),
              autoApprove: {
                enabled: values.autoApprove.enabled,
                minScore: Number(values.autoApprove.minScore),
                maxSizeGb: Number(values.autoApprove.maxSizeGb),
              },
              maxActiveJobs: Number(values.maxActiveJobs),
              minFreeSpaceGb: Number(values.minFreeSpaceGb),
              stallHours: Number(values.stallHours),
              slowHours: Number(values.slowHours),
              replaceFailed: values.replaceFailed,
              stepDown: {
                enabled: values.stepDown.enabled,
                days: Number(values.stepDown.days),
              },
              historyDays: Number(values.historyDays),
              agent: {
                autoRun: values.agent.autoRun,
                maxAutoRunsPerDay: Number(values.agent.maxAutoRunsPerDay),
                maxGrabsPerDay: Number(values.agent.maxGrabsPerDay),
                maxSizeGb: Number(values.agent.maxSizeGb),
                maxSteps: Number(values.agent.maxSteps),
                autoContinue: Number(values.agent.autoContinue),
                instructions: values.agent.instructions ?? '',
                keepDays: Number(values.agent.keepDays),
              },
            });
            addToast(intl.formatMessage(messages.saved), {
              appearance: 'success',
              autoDismiss: true,
            });
          } catch (e) {
            addToast(
              axios.isAxiosError(e) && e.response?.data?.message
                ? String(e.response.data.message)
                : intl.formatMessage(messages.saveFailed),
              { appearance: 'error', autoDismiss: true }
            );
          } finally {
            void mutate();
          }
        }}
      >
        {({ values, setFieldValue, isSubmitting }) => {
          const checkbox = (name: string, value: boolean) => (
            <Field
              type="checkbox"
              id={name}
              name={name}
              onChange={() => setFieldValue(name, !value)}
            />
          );
          return (
            <Form className="section">
              <div className="form-row">
                <label htmlFor="enabled" className="checkbox-label">
                  {intl.formatMessage(messages.enabled)}
                  <span className="label-tip">
                    {intl.formatMessage(messages.enabledTip)}
                  </span>
                </label>
                <div className="form-input-area">
                  {checkbox('enabled', values.enabled)}
                </div>
              </div>

              <h4 className="mt-8 text-lg font-semibold text-gray-200">
                {intl.formatMessage(messages.prowlarr)}
              </h4>
              <p
                className={`mt-2 text-sm ${
                  prowlarrReady
                    ? 'text-gray-400'
                    : 'text-yellow-300 light:text-warning-text'
                }`}
              >
                {intl.formatMessage(
                  prowlarrReady
                    ? messages.prowlarrAt
                    : messages.prowlarrMissing,
                  {
                    address: prowlarrAddress,
                    ServicesLink: (msg: React.ReactNode) => (
                      <Link
                        href="/settings/services"
                        className="text-indigo-400 hover:underline light:text-accent-text"
                      >
                        {msg}
                      </Link>
                    ),
                  }
                )}
              </p>

              <h4 className="mt-8 text-lg font-semibold text-gray-200">
                {intl.formatMessage(messages.downloads)}
              </h4>
              {noClients && (
                <div className="mt-4">
                  <Alert
                    type="warning"
                    title={intl.formatMessage(messages.noClients)}
                  />
                </div>
              )}
              <div className="form-row">
                <label htmlFor="torrentClientId" className="text-label">
                  {intl.formatMessage(messages.torrentClient)}
                </label>
                <div className="form-input-area">
                  <Field
                    as="select"
                    id="torrentClientId"
                    name="torrentClientId"
                  >
                    <option value="">
                      {intl.formatMessage(messages.noClient)}
                    </option>
                    {data.torrentClients.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Field>
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="usenetClientId" className="text-label">
                  {intl.formatMessage(messages.usenetClient)}
                </label>
                <div className="form-input-area">
                  <Field as="select" id="usenetClientId" name="usenetClientId">
                    <option value="">
                      {intl.formatMessage(messages.noClient)}
                    </option>
                    {data.usenetClients.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Field>
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="category" className="text-label">
                  {intl.formatMessage(messages.category)}
                  <span className="label-tip">
                    {intl.formatMessage(
                      musicReady
                        ? messages.categoryTipMusic
                        : messages.categoryTip
                    )}
                  </span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <Field id="category" name="category" type="text" />
                  </div>
                </div>
              </div>

              <h4 className="mt-8 text-lg font-semibold text-gray-200">
                {intl.formatMessage(messages.when)}
              </h4>
              {([['stuckAfterHours', messages.stuckAfterHours]] as const).map(
                ([name, label]) => (
                  <div className="form-row" key={name}>
                    <label htmlFor={name} className="text-label">
                      {intl.formatMessage(label)}
                    </label>
                    <div className="form-input-area">
                      <Field
                        id={name}
                        name={name}
                        type="text"
                        inputMode="numeric"
                        className="short"
                      />
                    </div>
                  </div>
                )
              )}
              <div className="form-row">
                <label htmlFor="includeMovies" className="checkbox-label">
                  {intl.formatMessage(messages.includeMovies)}
                  <span className="label-tip">
                    {intl.formatMessage(messages.includeMoviesTip)}
                  </span>
                </label>
                <div className="form-input-area">
                  {checkbox('includeMovies', values.includeMovies)}
                </div>
              </div>
              {musicReady && (
                <div className="form-row">
                  <label htmlFor="includeMusic" className="checkbox-label">
                    {intl.formatMessage(messages.includeMusic)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.includeMusicTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    {checkbox('includeMusic', values.includeMusic)}
                  </div>
                </div>
              )}
              <div className="form-row">
                <label htmlFor="includeCutoffUnmet" className="checkbox-label">
                  {intl.formatMessage(messages.includeCutoffUnmet)}
                  <span className="label-tip">
                    {intl.formatMessage(messages.includeCutoffUnmetTip)}
                  </span>
                </label>
                <div className="form-input-area">
                  {checkbox('includeCutoffUnmet', values.includeCutoffUnmet)}
                </div>
              </div>

              <h4 className="mt-8 text-lg font-semibold text-gray-200">
                {intl.formatMessage(messages.approval)}
              </h4>
              <div className="form-row">
                <label htmlFor="autoApprove.enabled" className="checkbox-label">
                  {intl.formatMessage(messages.autoApprove)}
                  <span className="label-tip">
                    {intl.formatMessage(messages.autoApproveTip)}
                  </span>
                </label>
                <div className="form-input-area">
                  {checkbox('autoApprove.enabled', values.autoApprove.enabled)}
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="replaceFailed" className="checkbox-label">
                  {intl.formatMessage(messages.replaceFailed)}
                  <span className="label-tip">
                    {intl.formatMessage(messages.replaceFailedTip)}
                  </span>
                </label>
                <div className="form-input-area">
                  {checkbox('replaceFailed', values.replaceFailed)}
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="stepDown.enabled" className="checkbox-label">
                  {intl.formatMessage(messages.stepDown)}
                  <span className="label-tip">
                    {intl.formatMessage(messages.stepDownTip)}
                  </span>
                </label>
                <div className="form-input-area">
                  {checkbox('stepDown.enabled', values.stepDown.enabled)}
                </div>
              </div>
              {values.stepDown.enabled && (
                <div className="form-row">
                  <label htmlFor="stepDown.days" className="text-label">
                    {intl.formatMessage(messages.stepDownDays)}
                  </label>
                  <div className="form-input-area">
                    <Field
                      id="stepDown.days"
                      name="stepDown.days"
                      type="text"
                      inputMode="numeric"
                      className="short"
                    />
                  </div>
                </div>
              )}
              {(values.autoApprove.enabled || values.replaceFailed) && (
                <>
                  <div className="form-row">
                    <label
                      htmlFor="autoApprove.minScore"
                      className="text-label"
                    >
                      {intl.formatMessage(messages.minScore)}
                    </label>
                    <div className="form-input-area">
                      <Field
                        id="autoApprove.minScore"
                        name="autoApprove.minScore"
                        type="text"
                        inputMode="numeric"
                        className="short"
                      />
                    </div>
                  </div>
                  <div className="form-row">
                    <label
                      htmlFor="autoApprove.maxSizeGb"
                      className="text-label"
                    >
                      {intl.formatMessage(messages.maxSizeGb)}
                    </label>
                    <div className="form-input-area">
                      <Field
                        id="autoApprove.maxSizeGb"
                        name="autoApprove.maxSizeGb"
                        type="text"
                        inputMode="numeric"
                        className="short"
                      />
                    </div>
                  </div>
                </>
              )}

              <h4 className="mt-8 text-lg font-semibold text-gray-200">
                {intl.formatMessage(messages.agent)}
              </h4>
              <p className="description">
                {intl.formatMessage(messages.agentTip)}
              </p>
              <div className="form-row">
                <label htmlFor="agent.autoRun" className="checkbox-label">
                  {intl.formatMessage(messages.agentAutoRun)}
                  <span className="label-tip">
                    {intl.formatMessage(messages.agentAutoRunTip)}
                  </span>
                </label>
                <div className="form-input-area">
                  {checkbox('agent.autoRun', values.agent.autoRun)}
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="agent.instructions" className="text-label">
                  {intl.formatMessage(messages.agentInstructions)}
                  <span className="label-tip">
                    {intl.formatMessage(messages.agentInstructionsTip)}
                  </span>
                </label>
                <div className="form-input-area">
                  <Field
                    as="textarea"
                    id="agent.instructions"
                    name="agent.instructions"
                    rows={4}
                    maxLength={2000}
                  />
                </div>
              </div>

              <AdvancedSection>
                <h4 className="mt-6 text-base font-semibold text-gray-300">
                  {intl.formatMessage(messages.when)}
                </h4>
                {(
                  [
                    ['searchesPerScan', messages.searchesPerScan],
                    ['researchAfterDays', messages.researchAfterDays],
                  ] as const
                ).map(([name, label]) => (
                  <div className="form-row" key={name}>
                    <label htmlFor={name} className="text-label">
                      {intl.formatMessage(label)}
                    </label>
                    <div className="form-input-area">
                      <Field
                        id={name}
                        name={name}
                        type="text"
                        inputMode="numeric"
                        className="short"
                      />
                    </div>
                  </div>
                ))}
                <div className="form-row">
                  <label htmlFor="includeSpecials" className="checkbox-label">
                    {intl.formatMessage(messages.includeSpecials)}
                  </label>
                  <div className="form-input-area">
                    {checkbox('includeSpecials', values.includeSpecials)}
                  </div>
                </div>
                <h4 className="mt-6 text-base font-semibold text-gray-300">
                  {intl.formatMessage(messages.safety)}
                </h4>
                {(
                  [
                    [
                      'maxActiveJobs',
                      messages.maxActiveJobs,
                      messages.maxActiveJobsTip,
                    ],
                    ['minFreeSpaceGb', messages.minFreeSpaceGb, undefined],
                    ['stallHours', messages.stallHours, messages.stallHoursTip],
                    ['slowHours', messages.slowHours, messages.slowHoursTip],
                    [
                      'historyDays',
                      messages.historyDays,
                      messages.historyDaysTip,
                    ],
                  ] as const
                ).map(([name, label, tip]) => (
                  <div className="form-row" key={name}>
                    <label htmlFor={name} className="text-label">
                      {intl.formatMessage(label)}
                      {tip && (
                        <span className="label-tip">
                          {intl.formatMessage(tip)}
                        </span>
                      )}
                    </label>
                    <div className="form-input-area">
                      <Field
                        id={name}
                        name={name}
                        type="text"
                        inputMode="numeric"
                        className="short"
                      />
                    </div>
                  </div>
                ))}
                <h4 className="mt-6 text-base font-semibold text-gray-300">
                  {intl.formatMessage(messages.agent)}
                </h4>
                {(
                  [
                    [
                      'agent.maxAutoRunsPerDay',
                      messages.agentMaxAutoRunsPerDay,
                      undefined,
                    ],
                    [
                      'agent.maxGrabsPerDay',
                      messages.agentMaxGrabsPerDay,
                      undefined,
                    ],
                    ['agent.maxSizeGb', messages.agentMaxSizeGb, undefined],
                    [
                      'agent.maxSteps',
                      messages.agentMaxSteps,
                      messages.agentMaxStepsTip,
                    ],
                    [
                      'agent.autoContinue',
                      messages.agentAutoContinue,
                      messages.agentAutoContinueTip,
                    ],
                    [
                      'agent.keepDays',
                      messages.agentKeepDays,
                      messages.agentKeepDaysTip,
                    ],
                  ] as const
                ).map(([name, label, tip]) => (
                  <div className="form-row" key={name}>
                    <label htmlFor={name} className="text-label">
                      {intl.formatMessage(label)}
                      {tip && (
                        <span className="label-tip">
                          {intl.formatMessage(tip)}
                        </span>
                      )}
                    </label>
                    <div className="form-input-area">
                      <Field
                        id={name}
                        name={name}
                        type="text"
                        inputMode="numeric"
                        className="short"
                      />
                    </div>
                  </div>
                ))}
              </AdvancedSection>

              <SaveBar>
                <div className="flex justify-end">
                  <span className="ml-3 inline-flex rounded-md shadow-sm">
                    <Button
                      buttonType="primary"
                      type="submit"
                      disabled={isSubmitting}
                    >
                      <ArrowDownOnSquareIcon />
                      <span>
                        {intl.formatMessage(
                          isSubmitting
                            ? globalMessages.saving
                            : globalMessages.save
                        )}
                      </span>
                    </Button>
                  </span>
                </div>
              </SaveBar>
            </Form>
          );
        }}
      </Formik>
      <DownloadCheck initial={data.downloadCheck?.mode ?? 'off'} />
      <BlockedGroups initial={data.blockedGroups ?? []} />
    </>
  );
};

export default SettingsBackfill;
