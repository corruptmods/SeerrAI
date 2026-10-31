import type { ApplyProgress } from '@server/lib/quality/engine';
import type { AxiosResponse } from 'axios';
import axios, { AxiosError } from 'axios';

/*
 * An apply or undo can take minutes on a big server, longer than a proxy
 * in front of Seerr AI waits. The server answers one that isn't done in a
 * few seconds with a job (202), and this follows it to the end, so the
 * answer is never lost to the proxy giving up.
 */

const POLL_MS = 800;
/** Polls that may fail in a row (a phone waking, say) before giving up. */
const MISSES = 15;

interface JobState {
  done: boolean;
  progress?: ApplyProgress | null;
  status?: number;
  body?: unknown;
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Posts a slow Quality request and answers as it finally did, throwing
 * an error as axios would for a failed one.
 */
export const postAndFollow = async <T>(
  url: string,
  body: unknown,
  onProgress?: (progress: ApplyProgress | null) => void
): Promise<T> => {
  const first = await axios.post<T | { job: string }>(url, body);
  const started = first.data as { job?: string };
  if (first.status !== 202 || !started.job) return first.data as T;

  let misses = 0;
  for (;;) {
    await wait(POLL_MS);
    let job: JobState;
    try {
      job = (
        await axios.get<JobState>(
          `/api/v1/settings/quality/jobs/${started.job}`
        )
      ).data;
      misses = 0;
    } catch (e) {
      // The server's own answer (a 404: the job is gone) ends it; a
      // network blip doesn't, for a while.
      if (axios.isAxiosError(e) && e.response) throw e;
      misses += 1;
      if (misses > MISSES) throw e;
      continue;
    }
    if (!job.done) {
      onProgress?.(job.progress ?? null);
      continue;
    }
    const status = job.status ?? 500;
    if (status >= 400) {
      const message =
        (job.body as { message?: string } | undefined)?.message ??
        `Request failed with status code ${status}`;
      throw new AxiosError(message, undefined, undefined, undefined, {
        status,
        data: job.body,
      } as AxiosResponse);
    }
    return job.body as T;
  }
};
