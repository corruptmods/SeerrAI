import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * What Seerr's own container is using, read from the kernel's accounting
 * for it (cgroups), the same figures `docker stats` shows. Only this
 * container: nothing here can see or reach any other. Both cgroup layouts
 * are read: v2 (TrueNAS, current Docker) and the older v1.
 */

export interface ContainerResources {
  /** False when the accounting could not be read (not in a container). */
  inContainer: boolean;
  memory?: {
    /** In use, not counting cache the kernel can drop (as docker stats). */
    used: number;
    /** The container's limit, or null when it has none. */
    limit: number | null;
    /** The machine's memory, what an unlimited container can grow into. */
    hostTotal: number;
  };
  cpu?: {
    /** Share of the CPUs available to it, 0–100; null until measurable. */
    percent: number | null;
    /** How many CPUs it may use: its limit, or the machine's. */
    cores: number;
  };
  processes?: { current: number; limit: number | null };
  /** Seerr's own Node.js process. */
  node: { rss: number; heapUsed: number; heapTotal: number };
  uptimeSeconds: number;
}

const read = async (file: string): Promise<string | undefined> => {
  try {
    return (await fs.readFile(file, 'utf8')).trim();
  } catch {
    return undefined;
  }
};

const number = (text: string | undefined): number | undefined => {
  if (text === undefined || text === '' || text === 'max') {
    return undefined;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
};

const statValue = (stat: string | undefined, key: string) =>
  number(
    stat
      ?.split('\n')
      .find((line) => line.startsWith(`${key} `))
      ?.split(' ')[1]
  );

/** "0-3,6" → 5 */
export const countCpus = (list: string | undefined): number | undefined => {
  if (!list) {
    return undefined;
  }
  let count = 0;
  for (const part of list.split(',')) {
    const [from, to] = part.split('-').map(Number);
    if (!Number.isFinite(from)) {
      return undefined;
    }
    count += Number.isFinite(to) ? to - from + 1 : 1;
  }
  return count || undefined;
};

/** Cumulative CPU time used, in microseconds, and the limits around it. */
interface Sample {
  usageUsec?: number;
  memoryUsage?: number;
  inactiveFile?: number;
  memoryLimit?: number;
  quotaCores?: number;
  cpusetCores?: number;
  pids?: number;
  pidsLimit?: number;
}

const sampleV2 = async (root: string): Promise<Sample> => {
  const [cpuStat, cpuMax, current, max, memStat, cpuset, pids, pidsMax] =
    await Promise.all(
      [
        'cpu.stat',
        'cpu.max',
        'memory.current',
        'memory.max',
        'memory.stat',
        'cpuset.cpus.effective',
        'pids.current',
        'pids.max',
      ].map((file) => read(path.join(root, file)))
    );
  const [quota, period] = (cpuMax ?? '').split(' ').map(number);
  return {
    usageUsec: statValue(cpuStat, 'usage_usec'),
    memoryUsage: number(current),
    inactiveFile: statValue(memStat, 'inactive_file'),
    memoryLimit: number(max),
    quotaCores: quota && period ? quota / period : undefined,
    cpusetCores: countCpus(cpuset),
    pids: number(pids),
    pidsLimit: number(pidsMax),
  };
};

const sampleV1 = async (root: string): Promise<Sample> => {
  const file = (...parts: string[]) => read(path.join(root, ...parts));
  const [usage, quota, period, current, limit, memStat, cpuset, pids, max] =
    await Promise.all([
      file('cpuacct', 'cpuacct.usage'),
      file('cpu', 'cpu.cfs_quota_us'),
      file('cpu', 'cpu.cfs_period_us'),
      file('memory', 'memory.usage_in_bytes'),
      file('memory', 'memory.limit_in_bytes'),
      file('memory', 'memory.stat'),
      file('cpuset', 'cpuset.effective_cpus'),
      file('pids', 'pids.current'),
      file('pids', 'pids.max'),
    ]);
  const quotaUs = number(quota);
  const periodUs = number(period);
  const usageNs = number(usage);
  return {
    usageUsec: usageNs === undefined ? undefined : usageNs / 1000,
    memoryUsage: number(current),
    inactiveFile:
      statValue(memStat, 'total_inactive_file') ??
      statValue(memStat, 'inactive_file'),
    memoryLimit: number(limit),
    quotaCores:
      quotaUs && quotaUs > 0 && periodUs ? quotaUs / periodUs : undefined,
    cpusetCores: countCpus(cpuset),
    pids: number(pids),
    pidsLimit: number(max),
  };
};

const sample = async (root: string): Promise<Sample | undefined> => {
  if ((await read(path.join(root, 'memory.current'))) !== undefined) {
    return sampleV2(root);
  }
  if (
    (await read(path.join(root, 'memory', 'memory.usage_in_bytes'))) !==
    undefined
  ) {
    return sampleV1(root);
  }
  return undefined;
};

export interface ResourcePoint {
  /** Epoch milliseconds. */
  t: number;
  /** Percent of the CPUs available to the container. */
  cpu: number | null;
  /** Bytes in use. */
  memory: number | null;
}

export interface ResourceHistory {
  current: ContainerResources;
  /** Every reading from the last hour. */
  recent: ResourcePoint[];
  /** The last day, as five-minute averages. */
  day: ResourcePoint[];
  intervalSeconds: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const BUCKET_MS = 5 * 60 * 1000;
const INTERVAL_MS = 15 * 1000;

const average = (values: (number | null)[]) => {
  const present = values.filter((v): v is number => v !== null);
  return present.length
    ? present.reduce((sum, v) => sum + v, 0) / present.length
    : null;
};

/**
 * Reads the container's use every 15 seconds and keeps the last hour of
 * readings and a day of five-minute averages, in memory: a restart starts
 * the history again, which is also when it would change anyway.
 */
export const createResourceMonitor = (root = '/sys/fs/cgroup') => {
  let previous: { usageUsec: number; at: number } | undefined;
  let latest: ContainerResources | undefined;
  let recent: ResourcePoint[] = [];
  let day: ResourcePoint[] = [];
  let bucket: ResourcePoint[] = [];
  let timer: NodeJS.Timeout | undefined;

  const read = async (at: number): Promise<ContainerResources> => {
    const memoryUsage = process.memoryUsage();
    const base = {
      node: {
        rss: memoryUsage.rss,
        heapUsed: memoryUsage.heapUsed,
        heapTotal: memoryUsage.heapTotal,
      },
      uptimeSeconds: Math.round(process.uptime()),
    };

    const now = await sample(root);
    if (!now) {
      return { inContainer: false, ...base };
    }

    const hostCores = os.availableParallelism?.() ?? os.cpus().length;
    const cores = Math.min(
      now.quotaCores ?? Infinity,
      now.cpusetCores ?? Infinity,
      hostCores
    );

    // CPU use is a rate: the time used since the last reading.
    let percent: number | null = null;
    if (now.usageUsec !== undefined) {
      if (previous && at > previous.at) {
        const elapsedUsec = (at - previous.at) * 1000;
        percent = Math.max(
          0,
          Math.min(
            100,
            ((now.usageUsec - previous.usageUsec) / (elapsedUsec * cores)) * 100
          )
        );
      }
      previous = { usageUsec: now.usageUsec, at };
    }

    const hostTotal = os.totalmem();
    // v1 reports "no limit" as a huge number rather than "max".
    const limit =
      now.memoryLimit !== undefined && now.memoryLimit < hostTotal
        ? now.memoryLimit
        : null;

    return {
      inContainer: true,
      memory:
        now.memoryUsage === undefined
          ? undefined
          : {
              used: Math.max(0, now.memoryUsage - (now.inactiveFile ?? 0)),
              limit,
              hostTotal,
            },
      cpu: { percent, cores: Number(cores.toFixed(2)) },
      processes:
        now.pids === undefined
          ? undefined
          : { current: now.pids, limit: now.pidsLimit ?? null },
      ...base,
    };
  };

  /** Take a reading and file it. */
  const tick = async (at = Date.now()) => {
    latest = await read(at);
    if (!latest.inContainer) {
      return latest;
    }
    const point: ResourcePoint = {
      t: at,
      cpu: latest.cpu?.percent ?? null,
      memory: latest.memory?.used ?? null,
    };
    recent = [...recent.filter((p) => p.t > at - HOUR_MS), point];

    bucket.push(point);
    if (point.t - bucket[0].t >= BUCKET_MS) {
      day = [
        ...day.filter((p) => p.t > at - DAY_MS),
        {
          t: bucket[bucket.length - 1].t,
          cpu: average(bucket.map((p) => p.cpu)),
          memory: average(bucket.map((p) => p.memory)),
        },
      ];
      bucket = [];
    }
    return latest;
  };

  return {
    tick,
    start: (intervalMs = INTERVAL_MS) => {
      if (timer) {
        return;
      }
      void tick();
      timer = setInterval(() => void tick(), intervalMs);
      // Never the reason the process stays up.
      timer.unref();
    },
    stop: () => {
      clearInterval(timer);
      timer = undefined;
    },
    /** The latest reading and the history behind it. */
    history: async (): Promise<ResourceHistory> => ({
      current: latest ?? (await tick()),
      recent,
      // The day so far, finished with the five minutes in progress.
      day: bucket.length
        ? [
            ...day,
            {
              t: bucket[bucket.length - 1].t,
              cpu: average(bucket.map((p) => p.cpu)),
              memory: average(bucket.map((p) => p.memory)),
            },
          ]
        : day,
      intervalSeconds: INTERVAL_MS / 1000,
    }),
  };
};

/** Seerr's own container, watched from startup. */
const resourceMonitor = createResourceMonitor();

export default resourceMonitor;
