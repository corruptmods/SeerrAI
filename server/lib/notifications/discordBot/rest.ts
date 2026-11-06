import type { DiscordBotTroubleReason } from '@server/interfaces/api/discordBotInterfaces';
import { getAppVersion } from '@server/utils/appVersion';

/*
 * Discord's REST API (v10) for the Discord bot, with Node's own fetch, which
 * goes through Settings → Network → HTTP(S) Proxy like everything else. The
 * token only ever goes in the Authorization header: errors carry Discord's
 * own words and code, never an address or header.
 */

export const DISCORD_API = 'https://discord.com/api/v10';

const TIMEOUT_MS = 15_000;

/** Tries per call while Discord says to slow down (429). */
const TRIES = 3;

/** A wait Discord asks for that is longer than this is given up on. */
const LONGEST_RETRY_MS = 30_000;

/**
 * For answering an interaction: Discord drops one not answered within three
 * seconds (10062), so only a very short wait is worth it.
 */
export const INTERACTION_RETRY_MS = 1_000;

export class DiscordApiError extends Error {
  public constructor(
    /** The HTTP status; 0 when Discord couldn't be reached. */
    public readonly status: number,
    /** Discord's JSON error code, such as 50001 Missing Access. */
    public readonly code: number | undefined,
    message: string
  ) {
    super(message);
    this.name = 'DiscordApiError';
  }
}

/** Discord's JSON error codes that the bot tells apart. */
export const DiscordErrorCode = {
  UNKNOWN_CHANNEL: 10003,
  UNKNOWN_MESSAGE: 10008,
  MISSING_ACCESS: 50001,
  MISSING_PERMISSIONS: 50013,
} as const;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done);
  });

/** Aborts when either does; `done` lets go of the long-lived one. */
const either = (long: AbortSignal, short: AbortSignal) => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (long.aborted || short.aborted) {
    abort();
  }
  long.addEventListener('abort', abort);
  short.addEventListener('abort', abort);
  return {
    signal: controller.signal,
    done: () => long.removeEventListener('abort', abort),
  };
};

const parse = (text: string): Record<string, unknown> | undefined => {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * One call to Discord as the bot. A 429 is waited out, as long as Discord
 * asks for no more than `longestRetryMs` (half a minute), and tried again.
 */
export async function discordRequest<T>(
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  longestRetryMs = LONGEST_RETRY_MS
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const combined = signal ? either(signal, timeout) : undefined;
    let response: Response;
    let text: string;
    try {
      response = await fetch(`${DISCORD_API}${path}`, {
        method,
        headers: {
          Authorization: `Bot ${token}`,
          'User-Agent': `DiscordBot (https://github.com/corruptmods/SeerrAI, ${getAppVersion()})`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combined?.signal ?? timeout,
      });
      text = await response.text();
    } catch (e) {
      if (signal?.aborted) {
        throw e;
      }
      throw new DiscordApiError(
        0,
        undefined,
        timeout.aborted
          ? `No answer from Discord within ${TIMEOUT_MS / 1000} seconds; gave up`
          : `Could not reach Discord: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      combined?.done();
    }

    const data = parse(text);

    if (response.status === 429 && attempt < TRIES) {
      const seconds = Number(
        data?.retry_after ?? response.headers.get('retry-after') ?? 1
      );
      const ms = Math.ceil((Number.isFinite(seconds) ? seconds : 1) * 1000);
      if (ms <= longestRetryMs) {
        await sleep(ms, signal);
        if (signal?.aborted) {
          throw new DiscordApiError(0, undefined, 'Stopped');
        }
        continue;
      }
    }

    if (!response.ok) {
      throw new DiscordApiError(
        response.status,
        typeof data?.code === 'number' ? data.code : undefined,
        typeof data?.message === 'string'
          ? data.message
          : `Discord answered ${response.status}`
      );
    }

    return data as T;
  }
}

/** What kind of trouble Discord's answer was, for the setup page. */
export const discordTrouble = (e: unknown): DiscordBotTroubleReason => {
  if (!(e instanceof DiscordApiError)) {
    return 'other';
  }
  if (e.status === 401) {
    return 'token';
  }
  if (e.status === 0 || e.status >= 500) {
    return 'unreachable';
  }
  if (
    e.code === DiscordErrorCode.MISSING_ACCESS ||
    e.code === DiscordErrorCode.UNKNOWN_CHANNEL
  ) {
    return 'access';
  }
  if (e.code === DiscordErrorCode.MISSING_PERMISSIONS) {
    return 'permissions';
  }
  return 'other';
};
