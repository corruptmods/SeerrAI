import AreaChart from '@app/components/Common/AreaChart';
import defineMessages from '@app/utils/defineMessages';
import type {
  ResourceHistory,
  ResourcePoint,
} from '@server/lib/containerResources';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.Settings.SettingsHealth.ContainerResources',
  {
    title: 'Seerr AI container',
    cpu: 'CPU',
    memory: 'Memory',
    ofCores: 'of {cores, plural, one {# CPU} other {# CPUs}}',
    ofLimit: 'of {limit} limit',
    noLimit: 'no limit set · {total} on this machine',
    measuring: 'measuring…',
    processes: 'Processes',
    nodeMemory: 'Node.js',
    uptime: 'Up for',
    upDays: '{days}d {hours}h',
    upHours: '{hours}h {minutes}m',
    upMinutes: '{minutes}m',
    lastHour: 'Last hour',
    lastDay: 'Last 24 hours',
    notContainer:
      'Not running in a container, so only Seerr AI’s own process is shown.',
    cpuChart: 'CPU use over time',
    memoryChart: 'Memory use over time',
    limit: 'limit',
  }
);

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

/** A round top for the memory scale: the limit, or room above the peak. */
const memoryScale = (points: ResourcePoint[], limit: number | null) => {
  if (limit) {
    return limit;
  }
  const peak = Math.max(0, ...points.map((p) => p.memory ?? 0));
  const target = Math.max(256 * MiB, peak * 1.25);
  const step = target > 2 * GiB ? GiB : 256 * MiB;
  return Math.ceil(target / step) * step;
};

const ContainerResources = () => {
  const intl = useIntl();
  const [range, setRange] = useState<'hour' | 'day'>('hour');
  const { data } = useSWR<ResourceHistory>(
    '/api/v1/settings/health/resources',
    { refreshInterval: 15 * 1000, revalidateOnFocus: true }
  );

  if (!data) {
    return null;
  }

  // Units in the reader's own language, as the browser writes them.
  const bytes = (value: number) =>
    value >= GiB
      ? intl.formatNumber(value / GiB, {
          style: 'unit',
          unit: 'gigabyte',
          maximumFractionDigits: 1,
        })
      : intl.formatNumber(value / MiB, {
          style: 'unit',
          unit: 'megabyte',
          maximumFractionDigits: 0,
        });
  const percent = (value: number) =>
    intl.formatNumber(value, {
      style: 'unit',
      unit: 'percent',
      maximumFractionDigits: value < 10 ? 1 : 0,
    });
  const time = (t: number) =>
    range === 'hour'
      ? intl.formatTime(t, { hour: 'numeric', minute: '2-digit' })
      : intl.formatDate(t, {
          weekday: 'short',
          hour: 'numeric',
          minute: '2-digit',
        });
  const duration = (seconds: number) => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return days
      ? intl.formatMessage(messages.upDays, { days, hours })
      : hours
        ? intl.formatMessage(messages.upHours, { hours, minutes })
        : intl.formatMessage(messages.upMinutes, { minutes });
  };

  const { current } = data;
  const points = range === 'hour' ? data.recent : data.day;
  const memoryMax = memoryScale(points, current.memory?.limit ?? null);

  return (
    <div className="mb-8 max-w-3xl xl:max-w-none">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold uppercase tracking-wider text-gray-400">
          {intl.formatMessage(messages.title)}
        </h4>
        {current.inContainer && (
          <div
            className="inline-flex overflow-hidden rounded-md border border-gray-600 text-xs"
            role="group"
          >
            {(['hour', 'day'] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={range === option}
                onClick={() => setRange(option)}
                className={`px-3 py-1 transition ${
                  range === option
                    ? 'bg-accent text-on-accent'
                    : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                }`}
              >
                {intl.formatMessage(
                  option === 'hour' ? messages.lastHour : messages.lastDay
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {!current.inContainer ? (
        <p className="mb-3 text-sm text-gray-400">
          {intl.formatMessage(messages.notContainer)}
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-md border border-gray-700 bg-gray-800 p-4 shadow">
            <div className="text-sm text-gray-400">
              {intl.formatMessage(messages.cpu)}
            </div>
            <div className="mb-3 flex flex-wrap items-baseline gap-x-2">
              <span className="text-2xl font-semibold text-strong">
                {current.cpu?.percent == null
                  ? intl.formatMessage(messages.measuring)
                  : percent(current.cpu.percent)}
              </span>
              <span className="text-sm text-gray-400">
                {intl.formatMessage(messages.ofCores, {
                  cores: current.cpu?.cores ?? 0,
                })}
              </span>
            </div>
            <AreaChart
              label={intl.formatMessage(messages.cpuChart)}
              points={points.map((p) => ({ t: p.t, v: p.cpu }))}
              max={100}
              formatValue={percent}
              formatTime={time}
            />
          </div>

          <div className="rounded-md border border-gray-700 bg-gray-800 p-4 shadow">
            <div className="text-sm text-gray-400">
              {intl.formatMessage(messages.memory)}
            </div>
            <div className="mb-3 flex flex-wrap items-baseline gap-x-2">
              <span className="text-2xl font-semibold text-strong">
                {current.memory ? bytes(current.memory.used) : '–'}
              </span>
              {current.memory && (
                <span className="text-sm text-gray-400">
                  {current.memory.limit
                    ? intl.formatMessage(messages.ofLimit, {
                        limit: bytes(current.memory.limit),
                      })
                    : intl.formatMessage(messages.noLimit, {
                        total: bytes(current.memory.hostTotal),
                      })}
                </span>
              )}
            </div>
            <AreaChart
              label={intl.formatMessage(messages.memoryChart)}
              points={points.map((p) => ({ t: p.t, v: p.memory }))}
              max={memoryMax}
              reference={
                current.memory?.limit
                  ? {
                      value: current.memory.limit,
                      label: intl.formatMessage(messages.limit),
                    }
                  : undefined
              }
              formatValue={bytes}
              formatTime={time}
            />
          </div>
        </div>
      )}

      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        {current.processes && (
          <div className="flex gap-2">
            <dt className="text-gray-400">
              {intl.formatMessage(messages.processes)}
            </dt>
            <dd className="text-gray-200">
              {intl.formatNumber(current.processes.current)}
            </dd>
          </div>
        )}
        <div className="flex gap-2">
          <dt className="text-gray-400">
            {intl.formatMessage(messages.nodeMemory)}
          </dt>
          <dd className="text-gray-200">{bytes(current.node.rss)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-gray-400">
            {intl.formatMessage(messages.uptime)}
          </dt>
          <dd className="text-gray-200">{duration(current.uptimeSeconds)}</dd>
        </div>
      </dl>
    </div>
  );
};

export default ContainerResources;
