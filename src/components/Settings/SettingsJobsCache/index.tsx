import Spinner from '@app/assets/spinner.svg';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import PageTitle from '@app/components/Common/PageTitle';
import Table from '@app/components/Common/Table';
import useLocale from '@app/hooks/useLocale';
import useMediaQuery from '@app/hooks/useMediaQuery';

import type { ScheduleInterval } from '@app/components/Settings/SettingsJobsCache/schedule';
import {
  SCHEDULE_CHOICES,
  choiceFor,
  scheduleFor,
} from '@app/components/Settings/SettingsJobsCache/schedule';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { formatBytes } from '@app/utils/numberHelpers';
import { Transition } from '@headlessui/react';
import { PlayIcon, StopIcon, TrashIcon } from '@heroicons/react/24/outline';
import { PencilIcon } from '@heroicons/react/24/solid';
import type {
  CacheItem,
  CacheResponse,
} from '@server/interfaces/api/settingsInterfaces';
import type { JobId } from '@server/lib/settings';
import axios from 'axios';
import cronstrue from 'cronstrue/i18n';
import humanizeDuration from 'humanize-duration';
import { Fragment, useReducer, useState } from 'react';
import type { MessageDescriptor } from 'react-intl';
import { FormattedRelativeTime, useIntl } from 'react-intl';
import useSWR from 'swr';

const messages: { [messageName: string]: MessageDescriptor } = defineMessages(
  'components.Settings.SettingsJobsCache',
  {
    jobsandcache: 'Jobs & Cache',
    jobs: 'Jobs',
    jobsDescription:
      'Scheduled maintenance jobs. Running one now doesn’t change its schedule.',
    jobname: 'Job Name',
    jobtype: 'Type',
    nextexecution: 'Next Execution',
    runnow: 'Run Now',
    canceljob: 'Cancel Job',
    jobstarted: '{jobname} started.',
    jobcancelled: '{jobname} canceled.',
    jobStartFailed: '{jobname} could not be started.',
    jobCancelFailed: '{jobname} could not be canceled.',
    process: 'Process',
    command: 'Command',
    cache: 'Cache',
    cacheDescription:
      'Answers from outside services, kept to save time and calls.',
    cacheflushed: '{cachename} cache flushed.',
    cacheFlushFailed: '{cachename} cache could not be flushed.',
    cachename: 'Cache Name',
    cachehits: 'Hits',
    cachemisses: 'Misses',
    cachekeys: 'Total Keys',
    cacheksize: 'Key Size',
    cachevsize: 'Value Size',
    flushcache: 'Flush Cache',
    dnsCache: 'DNS Cache',
    dnsCacheDescription: 'DNS lookups, kept to save time and calls.',
    dnscacheflushed: '{hostname} dns cache flushed.',
    dnscachename: 'Hostname',
    dnscacheactiveaddress: 'Active Address',
    dnscachehits: 'Hits',
    dnscachemisses: 'Misses',
    dnscacheage: 'Age',
    flushdnscache: 'Flush DNS Cache',
    dnsCacheGlobalStats: 'Global DNS Cache Stats',
    dnsCacheGlobalStatsDescription: 'Totals across all DNS cache entries.',
    dnsNoCacheEntries: 'No DNS lookups have been cached yet.',
    size: 'Size',
    hits: 'Hits',
    misses: 'Misses',
    failures: 'Failures',
    ipv4Fallbacks: 'IPv4 Fallbacks',
    hitRate: 'Hit Rate',
    unknownJob: 'Unknown Job',
    'plex-recently-added-scan': 'Plex Recently Added Scan',
    'plex-full-scan': 'Plex Full Library Scan',
    'plex-watchlist-sync': 'Watchlist Sync',
    'plex-refresh-token': 'Plex Refresh Token',
    'jellyfin-full-scan': 'Jellyfin Full Library Scan',
    'jellyfin-recently-added-scan': 'Jellyfin Recently Added Scan',
    'emby-full-scan': 'Emby Full Library Scan',
    'emby-recently-added-scan': 'Emby Recently Added Scan',
    'availability-sync': 'Media Availability Sync',
    'radarr-scan': 'Radarr Scan',
    'sonarr-scan': 'Sonarr Scan',
    'download-sync': 'Download Sync',
    'download-sync-reset': 'Download Sync Reset',
    'notification-reconcile': 'Notification Reconcile',
    'episode-sync': 'Episode Sync',
    'future-seasons': 'Future Season Requests',
    'plex-user-import': 'Plex User Import',
    'image-cache-cleanup': 'Image Cache Cleanup',
    'process-blocklisted-tags': 'Process Blocklisted Tags',
    'anime-check': 'Anime Check',
    'backfill-scan': 'Backfill Scan',
    'backfill-monitor': 'Backfill Downloads',
    'download-check': 'Download Check',
    'health-watch': 'Health Alerts',
    'plex-match-check': 'Match Check',
    'music-sync': 'Music Sync',
    'music-full-scan': 'Music Full Scan',
    'playlist-sync': 'Playlist Sync',
    'quality-check': 'Quality Profiles Check',
    'database-maintenance': 'Database Maintenance',
    editJobSchedule: 'Modify Job',
    jobScheduleEditSaved: 'Job edited successfully!',
    jobScheduleEditFailed: 'Something went wrong while saving the job.',
    editJobScheduleCurrent: 'Current Frequency',
    editJobSchedulePrompt: 'New Frequency',
    editJobScheduleSelectorDays:
      'Every {jobScheduleDays, plural, one {day} other {{jobScheduleDays} days}}',
    editJobScheduleSelectorHours:
      'Every {jobScheduleHours, plural, one {hour} other {{jobScheduleHours} hours}}',
    editJobScheduleSelectorMinutes:
      'Every {jobScheduleMinutes, plural, one {minute} other {{jobScheduleMinutes} minutes}}',
    editJobScheduleSelectorSeconds:
      'Every {jobScheduleSeconds, plural, one {second} other {{jobScheduleSeconds} seconds}}',
    imagecache: 'Image Cache',
    imagecacheDescription:
      'When on, outside images are cached in <code>{appDataPath}/cache/images</code>.',
    imagecachecount: 'Images Cached',
    imagecachesize: 'Total Cache Size',
    imagecachetotal: 'All images',
    imagecachelimit: '{size} of {limit}',
    imagecacheconversion: 'AVIF and WebP copies: {state}',
    imagecacheconversionon: 'made as images are viewed',
    imagecacheconversionoff:
      'not available on this server; images are served as they come',
    usersavatars: "Users' Avatars",
    tmdbcache: 'The Movie Database (tmdb)',
    tvdbcache: 'TheTVDB (tvdb)',
    musiccache: 'Music covers and artist pictures',
  }
);

interface Job {
  id: JobId;
  name: string;
  type: 'process' | 'command';
  interval: 'seconds' | 'minutes' | 'hours' | 'days' | 'fixed';
  cronSchedule: string;
  nextExecutionTime: string;
  running: boolean;
}

type JobModalState = {
  isOpen?: boolean;
  job?: Job;
  scheduleDays: number;
  scheduleHours: number;
  scheduleMinutes: number;
  scheduleSeconds: number;
};

type JobModalAction =
  | {
      type: 'set';
      days?: number;
      hours?: number;
      minutes?: number;
      seconds?: number;
    }
  | {
      type: 'close';
    }
  | { type: 'open'; job?: Job };

const jobModalReducer = (
  state: JobModalState,
  action: JobModalAction
): JobModalState => {
  switch (action.type) {
    case 'close':
      return {
        ...state,
        isOpen: false,
      };

    case 'open': {
      // Open on the job's own schedule where it is one of the choices, so
      // saving without a change keeps it.
      const saved = (interval: ScheduleInterval) =>
        action.job?.interval === interval
          ? choiceFor(interval, action.job.cronSchedule)
          : undefined;
      return {
        isOpen: true,
        job: action.job,
        scheduleDays: saved('days') ?? 1,
        scheduleHours: saved('hours') ?? 1,
        scheduleMinutes: saved('minutes') ?? 5,
        scheduleSeconds: saved('seconds') ?? 30,
      };
    }

    case 'set':
      return {
        ...state,
        scheduleDays: action.days ?? state.scheduleDays,
        scheduleHours: action.hours ?? state.scheduleHours,
        scheduleMinutes: action.minutes ?? state.scheduleMinutes,
        scheduleSeconds: action.seconds ?? state.scheduleSeconds,
      };
  }
};

const SettingsJobs = () => {
  const intl = useIntl();
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const { locale } = useLocale();
  const { addToast } = useToasts();
  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<Job[]>('/api/v1/settings/jobs', {
    refreshInterval: 5000,
  });
  const { data: appData } = useSWR('/api/v1/status/appdata');
  const { data: cacheData, mutate: cacheRevalidate } = useSWR<CacheResponse>(
    '/api/v1/settings/cache',
    {
      refreshInterval: 10000,
    }
  );

  const [jobModalState, dispatch] = useReducer(jobModalReducer, {
    isOpen: false,
    scheduleDays: 1,
    scheduleHours: 1,
    scheduleMinutes: 5,
    scheduleSeconds: 30,
  });
  const [isSaving, setIsSaving] = useState(false);

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  const failed = (message: string) =>
    addToast(message, { appearance: 'error', autoDismiss: true });

  const runJob = async (job: Job) => {
    const jobname = intl.formatMessage(messages[job.id] ?? messages.unknownJob);
    try {
      await axios.post(`/api/v1/settings/jobs/${job.id}/run`);
    } catch {
      return failed(intl.formatMessage(messages.jobStartFailed, { jobname }));
    }
    addToast(intl.formatMessage(messages.jobstarted, { jobname }), {
      appearance: 'success',
      autoDismiss: true,
    });
    revalidate();
  };

  const cancelJob = async (job: Job) => {
    const jobname = intl.formatMessage(messages[job.id] ?? messages.unknownJob);
    try {
      await axios.post(`/api/v1/settings/jobs/${job.id}/cancel`);
    } catch {
      return failed(intl.formatMessage(messages.jobCancelFailed, { jobname }));
    }
    addToast(intl.formatMessage(messages.jobcancelled, { jobname }), {
      appearance: 'error',
      autoDismiss: true,
    });
    revalidate();
  };

  const flushCache = async (cache: CacheItem) => {
    try {
      await axios.post(`/api/v1/settings/cache/${cache.id}/flush`);
    } catch {
      return failed(
        intl.formatMessage(messages.cacheFlushFailed, {
          cachename: cache.name,
        })
      );
    }
    addToast(
      intl.formatMessage(messages.cacheflushed, { cachename: cache.name }),
      {
        appearance: 'success',
        autoDismiss: true,
      }
    );
    cacheRevalidate();
  };

  const flushDnsCache = async (hostname: string) => {
    try {
      await axios.post(`/api/v1/settings/cache/dns/${hostname}/flush`);
    } catch {
      return failed(
        intl.formatMessage(messages.cacheFlushFailed, { cachename: hostname })
      );
    }
    addToast(
      intl.formatMessage(messages.dnscacheflushed, { hostname: hostname }),
      {
        appearance: 'success',
        autoDismiss: true,
      }
    );
    cacheRevalidate();
  };

  const scheduleJob = async () => {
    try {
      const job = jobModalState.job;
      // Jobs with a fixed interval are not editable.
      if (!job || job.interval === 'fixed') throw new Error();
      const schedule = scheduleFor(
        job.interval,
        {
          seconds: jobModalState.scheduleSeconds,
          minutes: jobModalState.scheduleMinutes,
          hours: jobModalState.scheduleHours,
          days: jobModalState.scheduleDays,
        }[job.interval]
      );

      setIsSaving(true);
      await axios.post(`/api/v1/settings/jobs/${job.id}/schedule`, {
        schedule,
      });

      addToast(intl.formatMessage(messages.jobScheduleEditSaved), {
        appearance: 'success',
        autoDismiss: true,
      });

      dispatch({ type: 'close' });
      revalidate();
    } catch {
      addToast(intl.formatMessage(messages.jobScheduleEditFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsSaving(false);
    }
  };

  const formatAge = (milliseconds: number): string => {
    return humanizeDuration(milliseconds, {
      units: ['m', 's'],
      round: true,
      language: locale,
    });
  };

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.jobsandcache),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <Transition
        as={Fragment}
        enter="transition-opacity duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity duration-300"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
        show={jobModalState.isOpen}
      >
        <Modal
          title={intl.formatMessage(messages.editJobSchedule)}
          okText={
            isSaving
              ? intl.formatMessage(globalMessages.saving)
              : intl.formatMessage(globalMessages.save)
          }
          onCancel={() => dispatch({ type: 'close' })}
          okDisabled={isSaving}
          onOk={() => scheduleJob()}
        >
          <div className="section">
            <form className="mb-6">
              <div className="form-row">
                <label className="text-label">
                  {intl.formatMessage(messages.editJobScheduleCurrent)}
                </label>
                <div className="form-input-area mb-1 mt-2">
                  <div>
                    {jobModalState.job &&
                      cronstrue.toString(jobModalState.job.cronSchedule, {
                        locale,
                      })}
                  </div>
                  <div className="text-sm text-gray-500">
                    {jobModalState.job?.cronSchedule}
                  </div>
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="jobSchedule" className="text-label">
                  {intl.formatMessage(messages.editJobSchedulePrompt)}
                </label>
                <div className="form-input-area">
                  {jobModalState.job?.interval === 'seconds' ? (
                    <select
                      id="jobSchedule"
                      name="jobScheduleSeconds"
                      className="inline"
                      value={jobModalState.scheduleSeconds}
                      onChange={(e) =>
                        dispatch({
                          type: 'set',
                          seconds: Number(e.target.value),
                        })
                      }
                    >
                      {SCHEDULE_CHOICES.seconds.map((v) => (
                        <option value={v} key={`jobScheduleSeconds-${v}`}>
                          {intl.formatMessage(
                            messages.editJobScheduleSelectorSeconds,
                            {
                              jobScheduleSeconds: v,
                            }
                          )}
                        </option>
                      ))}
                    </select>
                  ) : jobModalState.job?.interval === 'minutes' ? (
                    <select
                      id="jobSchedule"
                      name="jobScheduleMinutes"
                      className="inline"
                      value={jobModalState.scheduleMinutes}
                      onChange={(e) =>
                        dispatch({
                          type: 'set',
                          minutes: Number(e.target.value),
                        })
                      }
                    >
                      {SCHEDULE_CHOICES.minutes.map((v) => (
                        <option value={v} key={`jobScheduleMinutes-${v}`}>
                          {intl.formatMessage(
                            messages.editJobScheduleSelectorMinutes,
                            {
                              jobScheduleMinutes: v,
                            }
                          )}
                        </option>
                      ))}
                    </select>
                  ) : jobModalState.job?.interval === 'days' ? (
                    <select
                      id="jobSchedule"
                      name="jobScheduleDays"
                      className="inline"
                      value={jobModalState.scheduleDays}
                      onChange={(e) =>
                        dispatch({
                          type: 'set',
                          days: Number(e.target.value),
                        })
                      }
                    >
                      {SCHEDULE_CHOICES.days.map((v) => (
                        <option value={v} key={`jobScheduleDays-${v}`}>
                          {intl.formatMessage(
                            messages.editJobScheduleSelectorDays,
                            {
                              jobScheduleDays: v,
                            }
                          )}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <select
                      id="jobSchedule"
                      name="jobScheduleHours"
                      className="inline"
                      value={jobModalState.scheduleHours}
                      onChange={(e) =>
                        dispatch({
                          type: 'set',
                          hours: Number(e.target.value),
                        })
                      }
                    >
                      {SCHEDULE_CHOICES.hours.map((v) => (
                        <option value={v} key={`jobScheduleHours-${v}`}>
                          {intl.formatMessage(
                            messages.editJobScheduleSelectorHours,
                            {
                              jobScheduleHours: v,
                            }
                          )}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            </form>
          </div>
        </Modal>
      </Transition>

      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.jobs)}</h3>
        <p className="description">
          {intl.formatMessage(messages.jobsDescription)}
        </p>
      </div>
      <div className="section">
        {isDesktop && (
          <div>
            <Table>
              <thead>
                <tr>
                  <Table.TH>{intl.formatMessage(messages.jobname)}</Table.TH>
                  <Table.TH>{intl.formatMessage(messages.jobtype)}</Table.TH>
                  <Table.TH>
                    {intl.formatMessage(messages.nextexecution)}
                  </Table.TH>
                  <Table.TH />
                </tr>
              </thead>
              <Table.TBody>
                {data?.map((job) => (
                  <tr key={`job-list-${job.id}`}>
                    <Table.TD>
                      <div className="flex items-center text-sm leading-5 text-strong">
                        <span>
                          {intl.formatMessage(
                            messages[job.id] ?? messages.unknownJob
                          )}
                        </span>
                        {job.running && <Spinner className="ml-2 h-5 w-5" />}
                      </div>
                    </Table.TD>
                    <Table.TD>
                      <Badge
                        badgeType={
                          job.type === 'process' ? 'primary' : 'warning'
                        }
                        className="uppercase"
                      >
                        {job.type === 'process'
                          ? intl.formatMessage(messages.process)
                          : intl.formatMessage(messages.command)}
                      </Badge>
                    </Table.TD>
                    <Table.TD>
                      <div className="text-sm leading-5 text-strong">
                        <FormattedRelativeTime
                          value={Math.floor(
                            (new Date(job.nextExecutionTime).getTime() -
                              Date.now()) /
                              1000
                          )}
                          updateIntervalInSeconds={1}
                          numeric="auto"
                        />
                      </div>
                    </Table.TD>
                    <Table.TD alignText="right">
                      {job.interval !== 'fixed' && (
                        <Button
                          className="mr-2"
                          buttonType="warning"
                          onClick={() => dispatch({ type: 'open', job })}
                        >
                          <PencilIcon />
                          <span>{intl.formatMessage(globalMessages.edit)}</span>
                        </Button>
                      )}
                      {job.running ? (
                        <Button
                          buttonType="danger"
                          onClick={() => cancelJob(job)}
                        >
                          <StopIcon />
                          <span>{intl.formatMessage(messages.canceljob)}</span>
                        </Button>
                      ) : (
                        <Button
                          buttonType="primary"
                          onClick={() => runJob(job)}
                        >
                          <PlayIcon />
                          <span>{intl.formatMessage(messages.runnow)}</span>
                        </Button>
                      )}
                    </Table.TD>
                  </tr>
                ))}
              </Table.TBody>
            </Table>
          </div>
        )}
        {!isDesktop && (
          <div className="space-y-3">
            {data?.map((job) => (
              <div
                key={`job-card-${job.id}`}
                className="rounded-lg border border-gray-700 bg-gray-800 p-4"
              >
                <div className="flex items-start justify-between space-x-2">
                  <div className="flex min-w-0 items-center text-sm font-medium leading-5 text-strong">
                    <span className="truncate">
                      {intl.formatMessage(
                        messages[job.id] ?? messages.unknownJob
                      )}
                    </span>
                    {job.running && (
                      <Spinner className="ml-2 h-4 w-4 flex-shrink-0" />
                    )}
                  </div>
                  <Badge
                    badgeType={job.type === 'process' ? 'primary' : 'warning'}
                    className="flex-shrink-0 uppercase"
                  >
                    {job.type === 'process'
                      ? intl.formatMessage(messages.process)
                      : intl.formatMessage(messages.command)}
                  </Badge>
                </div>
                <div className="mt-2 text-sm leading-5 text-gray-300">
                  {intl.formatMessage(messages.nextexecution)}
                  {': '}
                  <FormattedRelativeTime
                    value={Math.floor(
                      (new Date(job.nextExecutionTime).getTime() - Date.now()) /
                        1000
                    )}
                    updateIntervalInSeconds={1}
                    numeric="auto"
                  />
                </div>
                <div className="mt-3 flex space-x-2">
                  {job.interval !== 'fixed' && (
                    <Button
                      className="flex-1 justify-center"
                      buttonType="warning"
                      onClick={() => dispatch({ type: 'open', job })}
                    >
                      <PencilIcon />
                      <span>{intl.formatMessage(globalMessages.edit)}</span>
                    </Button>
                  )}
                  {job.running ? (
                    <Button
                      className="flex-1 justify-center"
                      buttonType="danger"
                      onClick={() => cancelJob(job)}
                    >
                      <StopIcon />
                      <span>{intl.formatMessage(messages.canceljob)}</span>
                    </Button>
                  ) : (
                    <Button
                      className="flex-1 justify-center"
                      buttonType="primary"
                      onClick={() => runJob(job)}
                    >
                      <PlayIcon />
                      <span>{intl.formatMessage(messages.runnow)}</span>
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div>
        <h3 className="heading">{intl.formatMessage(messages.cache)}</h3>
        <p className="description">
          {intl.formatMessage(messages.cacheDescription)}
        </p>
      </div>
      <div className="section">
        <Table>
          <thead>
            <tr>
              <Table.TH>{intl.formatMessage(messages.cachename)}</Table.TH>
              <Table.TH>{intl.formatMessage(messages.cachehits)}</Table.TH>
              <Table.TH>{intl.formatMessage(messages.cachemisses)}</Table.TH>
              <Table.TH>{intl.formatMessage(messages.cachekeys)}</Table.TH>
              <Table.TH>{intl.formatMessage(messages.cacheksize)}</Table.TH>
              <Table.TH>{intl.formatMessage(messages.cachevsize)}</Table.TH>
              <Table.TH />
            </tr>
          </thead>
          <Table.TBody>
            {cacheData?.apiCaches?.map((cache) => (
              <tr key={`cache-list-${cache.id}`}>
                <Table.TD>{cache.name}</Table.TD>
                <Table.TD>{intl.formatNumber(cache.stats.hits)}</Table.TD>
                <Table.TD>{intl.formatNumber(cache.stats.misses)}</Table.TD>
                <Table.TD>{intl.formatNumber(cache.stats.keys)}</Table.TD>
                <Table.TD>{formatBytes(cache.stats.ksize)}</Table.TD>
                <Table.TD>{formatBytes(cache.stats.vsize)}</Table.TD>
                <Table.TD alignText="right">
                  <Button buttonType="danger" onClick={() => flushCache(cache)}>
                    <TrashIcon />
                    <span>{intl.formatMessage(messages.flushcache)}</span>
                  </Button>
                </Table.TD>
              </tr>
            ))}
          </Table.TBody>
        </Table>
      </div>
      {cacheData?.dnsCache != null && (
        <>
          <div>
            <h3 className="heading">{intl.formatMessage(messages.dnsCache)}</h3>
            <p className="description">
              {intl.formatMessage(messages.dnsCacheDescription)}
            </p>
          </div>
          <div className="section">
            <Table>
              <thead>
                <tr>
                  <Table.TH>
                    {intl.formatMessage(messages.dnscachename)}
                  </Table.TH>
                  <Table.TH>
                    {intl.formatMessage(messages.dnscacheactiveaddress)}
                  </Table.TH>
                  <Table.TH>
                    {intl.formatMessage(messages.dnscachehits)}
                  </Table.TH>
                  <Table.TH>
                    {intl.formatMessage(messages.dnscachemisses)}
                  </Table.TH>
                  <Table.TH>
                    {intl.formatMessage(messages.dnscacheage)}
                  </Table.TH>
                  <Table.TH />
                </tr>
              </thead>
              <Table.TBody>
                {(() => {
                  if (!cacheData) {
                    return (
                      <tr>
                        <Table.TD colSpan={6} alignText="center">
                          <LoadingSpinner />
                        </Table.TD>
                      </tr>
                    );
                  }

                  const entries = Object.entries(
                    cacheData.dnsCache?.entries ?? {}
                  );

                  if (entries.length === 0) {
                    return (
                      <tr>
                        <Table.TD colSpan={6} alignText="center">
                          {intl.formatMessage(messages.dnsNoCacheEntries)}
                        </Table.TD>
                      </tr>
                    );
                  }

                  return entries.map(([hostname, data]) => (
                    <tr key={`cache-list-${hostname}`}>
                      <Table.TD>{hostname}</Table.TD>
                      <Table.TD>{data.activeAddress}</Table.TD>
                      <Table.TD>{intl.formatNumber(data.hits)}</Table.TD>
                      <Table.TD>{intl.formatNumber(data.misses)}</Table.TD>
                      <Table.TD>{formatAge(data.age)}</Table.TD>
                      <Table.TD alignText="right">
                        <Button
                          buttonType="danger"
                          onClick={() => flushDnsCache(hostname)}
                        >
                          <TrashIcon />
                          <span>
                            {intl.formatMessage(messages.flushdnscache)}
                          </span>
                        </Button>
                      </Table.TD>
                    </tr>
                  ));
                })()}
              </Table.TBody>
            </Table>
          </div>
          <div>
            <h3 className="heading">
              {intl.formatMessage(messages.dnsCacheGlobalStats)}
            </h3>
            <p className="description">
              {intl.formatMessage(messages.dnsCacheGlobalStatsDescription)}
            </p>
          </div>
          <div className="section">
            {!cacheData ? (
              <LoadingSpinner />
            ) : (
              <Table>
                <thead>
                  <tr>
                    {Object.entries(cacheData.dnsCache?.stats ?? {})
                      .filter(([statName]) => statName !== 'maxSize')
                      .map(([statName]) => (
                        <Table.TH key={`dns-stat-header-${statName}`}>
                          {messages[statName]
                            ? intl.formatMessage(messages[statName])
                            : statName}
                        </Table.TH>
                      ))}
                  </tr>
                </thead>
                <Table.TBody>
                  <tr>
                    {Object.entries(cacheData.dnsCache?.stats ?? {})
                      .filter(([statName]) => statName !== 'maxSize')
                      .map(([statName, statValue]) => (
                        <Table.TD key={`dns-stat-${statName}`}>
                          {statName === 'hitRate'
                            ? intl.formatNumber(statValue, {
                                style: 'percent',
                                maximumFractionDigits: 2,
                              })
                            : intl.formatNumber(statValue)}
                        </Table.TD>
                      ))}
                  </tr>
                </Table.TBody>
              </Table>
            )}
          </div>
        </>
      )}
      <div className="break-words">
        <h3 className="heading">{intl.formatMessage(messages.imagecache)}</h3>
        <p className="description">
          {intl.formatMessage(messages.imagecacheDescription, {
            code: (msg: React.ReactNode) => (
              <code key="code-block" className="bg-gray-800/50">
                {msg}
              </code>
            ),
            appDataPath: appData ? appData.appDataPath : '/app/config',
          })}
        </p>
      </div>
      <div className="section">
        <Table>
          <thead>
            <tr>
              <Table.TH>{intl.formatMessage(messages.cachename)}</Table.TH>
              <Table.TH>
                {intl.formatMessage(messages.imagecachecount)}
              </Table.TH>
              <Table.TH>{intl.formatMessage(messages.imagecachesize)}</Table.TH>
            </tr>
          </thead>
          <Table.TBody>
            <tr>
              <Table.TD>{intl.formatMessage(messages.tmdbcache)}</Table.TD>
              <Table.TD>
                {intl.formatNumber(cacheData?.imageCache.tmdb.imageCount ?? 0)}
              </Table.TD>
              <Table.TD>
                {formatBytes(cacheData?.imageCache.tmdb.size ?? 0)}
              </Table.TD>
            </tr>
            <tr>
              <Table.TD>{intl.formatMessage(messages.tvdbcache)}</Table.TD>
              <Table.TD>
                {intl.formatNumber(cacheData?.imageCache.tvdb?.imageCount ?? 0)}
              </Table.TD>
              <Table.TD>
                {formatBytes(cacheData?.imageCache.tvdb?.size ?? 0)}
              </Table.TD>
            </tr>
            <tr>
              <Table.TD>
                {intl.formatMessage(messages.usersavatars)} (avatar)
              </Table.TD>
              <Table.TD>
                {intl.formatNumber(
                  cacheData?.imageCache.avatar.imageCount ?? 0
                )}
              </Table.TD>
              <Table.TD>
                {formatBytes(cacheData?.imageCache.avatar.size ?? 0)}
              </Table.TD>
            </tr>
            <tr>
              <Table.TD>{intl.formatMessage(messages.musiccache)}</Table.TD>
              <Table.TD>
                {intl.formatNumber(
                  cacheData?.imageCache.music?.imageCount ?? 0
                )}
              </Table.TD>
              <Table.TD>
                {formatBytes(cacheData?.imageCache.music?.size ?? 0)}
              </Table.TD>
            </tr>
            {cacheData?.imageCacheTotal && (
              <tr>
                <Table.TD className="font-semibold">
                  {intl.formatMessage(messages.imagecachetotal)}
                </Table.TD>
                <Table.TD />
                <Table.TD className="font-semibold">
                  {intl.formatMessage(messages.imagecachelimit, {
                    size: formatBytes(cacheData.imageCacheTotal.size),
                    limit: formatBytes(cacheData.imageCacheTotal.limit),
                  })}
                </Table.TD>
              </tr>
            )}
          </Table.TBody>
        </Table>
        {cacheData?.imageCacheTotal && (
          <p className="mt-3 text-sm text-gray-400">
            {intl.formatMessage(messages.imagecacheconversion, {
              state: intl.formatMessage(
                cacheData.imageCacheTotal.conversion
                  ? messages.imagecacheconversionon
                  : messages.imagecacheconversionoff
              ),
            })}
          </p>
        )}
      </div>
    </>
  );
};

export default SettingsJobs;
