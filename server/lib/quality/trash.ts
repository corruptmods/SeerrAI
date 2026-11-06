import type { TrashData, TrashMetadata } from '@server/lib/quality/trashData';
import { compileTrashApp, inFolder } from '@server/lib/quality/trashData';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { appDataPath } from '@server/utils/appDataVolume';
import { proxyRequestInterceptor } from '@server/utils/customProxyAgent';
import { userAgentRequestInterceptor } from '@server/utils/userAgent';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import reviewed from './trash-reviewed.json';

/*
 * TRaSH Guides (https://trash-guides.info, MIT licence, copyright TRaSH):
 * the Radarr and Sonarr JSON files from its GitHub repo, the same ones
 * Recyclarr reads. Checked every 24 hours; only changed files are fetched,
 * and the copy in the config folder keeps working when GitHub is unreachable.
 */

const REPO = 'TRaSH-Guides/Guides';
const BRANCH = 'master';
const API = 'https://api.github.com';
/** A commit sha; rejects anything that could act as a path segment. */
const COMMIT = /^[0-9a-z]{1,64}$/i;
const RAW = 'https://raw.githubusercontent.com';
const LABEL = 'Quality';

export * from '@server/lib/quality/trashData';

export const TRASH_CREDIT =
  'TRaSH Guides, MIT licence, copyright (c) 2021 TRaSH. https://trash-guides.info';

export interface TrashState {
  commit?: string;
  /** When GitHub last answered. */
  checkedAt?: string;
  /** Last failed check and its error; cleared by the next success. */
  failedAt?: string;
  error?: string;
  /** ETag of the commit response, so an unchanged commit costs nothing. */
  etag?: string;
  /** Path → blob sha of each file kept. */
  blobs: Record<string, string>;
}

const trashDir = () => path.join(appDataPath(), 'trash');
const statePath = () => path.join(trashDir(), 'state.json');
const dataPath = () => path.join(trashDir(), 'data.json');

/** Far above the repo's tree listing and any file kept. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

const http = axios.create({
  timeout: 30_000,
  maxContentLength: MAX_RESPONSE_BYTES,
});
http.interceptors.request.use(proxyRequestInterceptor);
http.interceptors.request.use(userAgentRequestInterceptor);
/** For tests: the GitHub HTTP client. */
export const trashHttp = http;

let cached: TrashData | null | undefined;

export const readTrashState = async (): Promise<TrashState> => {
  try {
    return JSON.parse(await fs.readFile(statePath(), 'utf-8')) as TrashState;
  } catch {
    return { blobs: {} };
  }
};

const writeJson = async (file: string, value: unknown) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value));
  await fs.rename(temp, file);
};

/** The last fetched TRaSH Guides copy, or null if none yet. */
export const trashData = async (): Promise<TrashData | null> => {
  if (cached !== undefined) return cached;
  try {
    cached = JSON.parse(await fs.readFile(dataPath(), 'utf-8')) as TrashData;
  } catch {
    cached = null;
  }
  return cached;
};

/** For tests: sets TRaSH data as if fetched. */
export const setTrashDataForTests = (data: TrashData | null) => {
  cached = data;
};

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
}

const fetchRaw = async <T>(commit: string, file: string): Promise<T> => {
  const { data } = await http.get<T>(`${RAW}/${REPO}/${commit}/${file}`, {
    responseType: 'json',
  });
  return data;
};

/** Runs the work a few items at a time. */
const inBatches = async <T>(
  items: T[],
  size: number,
  work: (item: T) => Promise<void>
) => {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(work));
  }
};

/** Whether `head` is `base` or a later commit on its history. */
const followsOn = async (base: string, head: string): Promise<boolean> => {
  const { data } = await http.get<{ status?: string }>(
    `${API}/repos/${REPO}/compare/${base}...${head}`,
    { headers: { Accept: 'application/vnd.github+json' } }
  );
  return data?.status === 'ahead' || data?.status === 'identical';
};

let refreshing: Promise<TrashState> | null = null;

/**
 * Checks GitHub for a newer TRaSH Guides and fetches changed files. Returns
 * the resulting state; a failure is recorded there (and logged) and the
 * existing copy stays in use. Concurrent callers share one check.
 */
export const refreshTrash = (): Promise<TrashState> => {
  refreshing ??= check().finally(() => {
    refreshing = null;
  });
  return refreshing;
};

/** Checks only if the last check is older than `ms`. */
export const refreshTrashIfOlder = async (ms: number): Promise<TrashState> => {
  const state = await readTrashState();
  const last = Date.parse(state.checkedAt ?? '') || 0;
  return Date.now() - last < ms ? state : refreshTrash();
};

const check = async (): Promise<TrashState> => {
  const state = await readTrashState();
  try {
    const kept = !!state.commit && !!(await trashData());
    // A 304 doesn't count against GitHub's hourly rate limit.
    const head = await http.get<{ sha: string }>(
      `${API}/repos/${REPO}/commits/${BRANCH}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          ...(kept && state.etag ? { 'If-None-Match': state.etag } : {}),
        },
        validateStatus: (status) =>
          (status >= 200 && status < 300) || status === 304,
      }
    );
    const commit = head.status === 304 ? state.commit : head.data?.sha;
    if (!commit || !COMMIT.test(commit)) {
      throw new Error('GitHub gave no commit');
    }
    const etag =
      typeof head.headers.etag === 'string' ? head.headers.etag : state.etag;
    if (kept && commit === state.commit) {
      const next: TrashState = {
        ...state,
        etag,
        checkedAt: new Date().toISOString(),
      };
      delete next.error;
      delete next.failedAt;
      await writeJson(statePath(), next);
      return next;
    }

    // Applied unseen, an update must follow on from the copy already taken
    // (or the one last reviewed), never replace its history.
    const base = state.commit ?? reviewed.commit;
    if (
      getSettings().quality.trash.autoApply &&
      COMMIT.test(base) &&
      commit !== base &&
      !(await followsOn(base, commit))
    ) {
      throw new Error(
        `TRaSH Guides' latest commit does not follow on from ${base.slice(0, 7)}; it is taken only with automatic updates off.`
      );
    }

    const metadata = await fetchRaw<TrashMetadata>(commit, 'metadata.json');
    const { data: tree } = await http.get<{ tree: TreeEntry[] }>(
      `${API}/repos/${REPO}/git/trees/${commit}`,
      {
        params: { recursive: 1 },
        headers: { Accept: 'application/vnd.github+json' },
      }
    );
    const filesDir = path.resolve(trashDir(), 'files');
    const wanted = tree.tree.filter((entry) => {
      if (entry.type !== 'blob') return false;
      // Skip any path that resolves outside files/.
      const local = path.resolve(filesDir, entry.path);
      if (!local.startsWith(`${filesDir}${path.sep}`)) return false;
      return (['radarr', 'sonarr'] as const).some((kind) => {
        const p = metadata.json_paths[kind];
        return (
          inFolder(entry.path, p.custom_formats) ||
          inFolder(entry.path, p.quality_profiles) ||
          inFolder(entry.path, p.custom_format_groups) ||
          inFolder(entry.path, p.qualities) ||
          (p.conflicts ?? []).includes(entry.path)
        );
      });
    });

    const files: Record<string, unknown> = {};
    const blobs: Record<string, string> = {};
    await inBatches(wanted, 8, async (entry) => {
      const local = path.join(filesDir, entry.path);
      let value: unknown;
      if (state.blobs[entry.path] === entry.sha) {
        try {
          value = JSON.parse(await fs.readFile(local, 'utf-8'));
        } catch {
          value = undefined;
        }
      }
      if (value === undefined) {
        value = await fetchRaw(commit, entry.path);
        await writeJson(local, value);
      }
      files[entry.path] = value;
      blobs[entry.path] = entry.sha;
    });

    const data: TrashData = {
      commit,
      radarr: compileTrashApp(files, metadata, 'radarr'),
      sonarr: compileTrashApp(files, metadata, 'sonarr'),
    };
    await writeJson(dataPath(), data);
    cached = data;
    const next: TrashState = {
      commit,
      etag,
      checkedAt: new Date().toISOString(),
      blobs,
    };
    await writeJson(statePath(), next);
    logger.info('TRaSH Guides updated', {
      label: LABEL,
      commit: commit.slice(0, 7),
      files: wanted.length,
    });
    return next;
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    logger.warn('Could not check TRaSH Guides', {
      label: LABEL,
      errorMessage: why,
    });
    const next = {
      ...state,
      failedAt: new Date().toISOString(),
      error: why,
    };
    await writeJson(statePath(), next).catch(() => undefined);
    return next;
  }
};
