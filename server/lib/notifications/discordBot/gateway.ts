import {
  DiscordApiError,
  discordRequest,
} from '@server/lib/notifications/discordBot/rest';

/*
 * A connection to Discord's Gateway (v10, JSON), over which button presses
 * arrive. Seerr AI connects out, so no port has to be open. It heartbeats as
 * Discord asks, with the first beat at a random point of the interval, and
 * reconnects when a beat goes unanswered; after a dropped connection it
 * resumes the session where it can, so nothing pressed meanwhile is lost.
 * Discord's refusals that retrying can't fix (a bad token, say) end the run.
 */

export const GatewayOp = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/**
 * None: interactions (button presses) reach a bot whatever its intents, and
 * the bot reads nothing else from the Gateway.
 */
export const GATEWAY_INTENTS = 0;

/** Our own close code for reconnecting: unlike 1000, it keeps the session. */
const RECONNECT_CLOSE = 4000;
const FINAL_CLOSE = 1000;

/** The parts of a WebSocket used here; Node's own by default. */
export interface GatewaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: 'message' | 'close' | 'error',
    listener: (event: {
      data?: unknown;
      code?: number;
      reason?: string;
    }) => void
  ): void;
}

export type GatewaySocketConstructor = new (url: string) => GatewaySocket;

export interface GatewayUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
}

export interface GatewayHooks {
  /** Identified (with the bot's user) or resumed (without). */
  onReady(user?: GatewayUser): void;
  onDispatch(event: string, data: unknown): void;
  /** The connection was lost or couldn't be made; trying again. */
  onTrouble(detail: string): void;
}

/** Why Discord won't have the bot connect, until something is changed. */
export type RefusedReason = 'token' | 'intents' | 'other';

export type GatewayEnd =
  | { kind: 'stopped' }
  | { kind: 'refused'; reason: RefusedReason; detail: string };

type Outcome =
  | GatewayEnd
  | {
      kind: 'again';
      resume: boolean;
      /** The connection had got going (READY or RESUMED). */
      healthy: boolean;
      wait: 'now' | 'invalidSession' | 'backoff';
      detail: string;
    };

export interface GatewayWaits {
  /** First wait after a failure, doubling up to `longestMs`. */
  retryMs: number;
  longestMs: number;
  /** How long Discord has to say Hello once connecting. */
  helloMs: number;
  /** How long a closing connection has to finish before moving on. */
  closeMs: number;
  /** Discord allows one Identify per five seconds. */
  identifyGapMs: number;
  /** After an Invalid Session Discord asks for a random 1–5 s wait. */
  invalidSessionMs: [number, number];
}

export const DEFAULT_GATEWAY_WAITS: GatewayWaits = {
  retryMs: 2_000,
  longestMs: 5 * 60_000,
  helloMs: 30_000,
  closeMs: 5_000,
  identifyGapMs: 5_500,
  invalidSessionMs: [1_000, 5_000],
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });

const refusal = (code: number): RefusedReason | undefined => {
  switch (code) {
    case 4004:
      return 'token';
    case 4014:
      return 'intents';
    // Invalid shard, sharding required, invalid API version, invalid
    // intents: only a code change fixes these.
    case 4010:
    case 4011:
    case 4012:
    case 4013:
      return 'other';
  }
};

/**
 * When the bot last identified. Kept by whoever makes the Gateways, so the
 * gap between Identifies holds across connections made after a restart.
 */
export interface IdentifyClock {
  lastAt: number;
}

export class Gateway {
  private sessionId?: string;
  private resumeUrl?: string;
  private seq: number | null = null;

  public constructor(
    private readonly token: string,
    private readonly hooks: GatewayHooks,
    private readonly Socket: GatewaySocketConstructor,
    private readonly waits: GatewayWaits = DEFAULT_GATEWAY_WAITS,
    private readonly random: () => number = Math.random,
    private readonly identified: IdentifyClock = { lastAt: 0 }
  ) {}

  /** Stays connected until `signal` aborts or Discord refuses for good. */
  public async run(signal: AbortSignal): Promise<GatewayEnd> {
    let url: string | undefined;
    let failures = 0;
    const backoff = () =>
      Math.min(this.waits.retryMs * 2 ** (failures - 1), this.waits.longestMs);

    while (!signal.aborted) {
      if (!url) {
        try {
          const found = await discordRequest<{
            url: string;
            session_start_limit?: { remaining: number; reset_after: number };
          }>(this.token, 'GET', '/gateway/bot', undefined, signal);
          const limit = found.session_start_limit;
          if (limit && limit.remaining < 1) {
            this.hooks.onTrouble(
              'Discord allows this bot no more connections for now; waiting until it does'
            );
            await sleep(limit.reset_after, signal);
            continue;
          }
          url = found.url;
        } catch (e) {
          if (signal.aborted) {
            break;
          }
          if (e instanceof DiscordApiError && e.status === 401) {
            return { kind: 'refused', reason: 'token', detail: e.message };
          }
          failures += 1;
          this.hooks.onTrouble(e instanceof Error ? e.message : String(e));
          await sleep(backoff(), signal);
          continue;
        }
      }

      const resume = this.canResume();
      if (!resume) {
        await sleep(
          this.identified.lastAt + this.waits.identifyGapMs - Date.now(),
          signal
        );
        if (signal.aborted) {
          break;
        }
      }

      const outcome = await this.connect(
        resume ? this.resumeUrl! : url,
        resume,
        signal
      );
      if (outcome.kind !== 'again') {
        return outcome;
      }

      if (!outcome.resume) {
        this.forget();
      }
      failures = outcome.healthy ? 1 : failures + 1;
      this.hooks.onTrouble(outcome.detail);

      const [least, most] = this.waits.invalidSessionMs;
      await sleep(
        outcome.wait === 'now'
          ? 0
          : outcome.wait === 'invalidSession'
            ? least + this.random() * (most - least)
            : backoff(),
        signal
      );
    }

    return { kind: 'stopped' };
  }

  private canResume(): boolean {
    return !!(this.sessionId && this.resumeUrl && this.seq !== null);
  }

  private forget(): void {
    this.sessionId = undefined;
    this.resumeUrl = undefined;
    this.seq = null;
  }

  /** One connection, from opening it until it has closed. */
  private connect(
    url: string,
    resume: boolean,
    signal: AbortSignal
  ): Promise<Outcome> {
    return new Promise((resolve) => {
      let socket: GatewaySocket;
      try {
        socket = new this.Socket(`${url}/?v=10&encoding=json`);
      } catch (e) {
        resolve({
          kind: 'again',
          resume,
          healthy: false,
          wait: 'backoff',
          detail: e instanceof Error ? e.message : String(e),
        });
        return;
      }

      let ready = false;
      let acked = true;
      let decided: Outcome | undefined;
      let settled = false;
      let beat: ReturnType<typeof setTimeout> | undefined;
      let closing: ReturnType<typeof setTimeout> | undefined;

      const again = (
        detail: string,
        resumeNext = true,
        wait: 'now' | 'invalidSession' | 'backoff' = 'backoff'
      ): Outcome => ({
        kind: 'again',
        resume: resumeNext,
        healthy: ready,
        wait,
        detail,
      });

      const settle = (outcome: Outcome) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(hello);
        clearTimeout(beat);
        clearTimeout(closing);
        signal.removeEventListener('abort', stop);
        resolve(outcome);
      };

      // Decided here: close it, and carry on once it has closed, so two
      // connections are never open at once.
      const end = (outcome: Outcome, code: number) => {
        if (decided) {
          return;
        }
        decided = outcome;
        clearTimeout(hello);
        clearTimeout(beat);
        try {
          socket.close(code);
        } catch {
          // Already closed.
        }
        closing = setTimeout(() => settle(outcome), this.waits.closeMs);
      };

      const stop = () => end({ kind: 'stopped' }, FINAL_CLOSE);

      const send = (payload: object) => {
        try {
          socket.send(JSON.stringify(payload));
        } catch {
          // The close that follows decides what happens.
        }
      };
      const heartbeat = () => send({ op: GatewayOp.HEARTBEAT, d: this.seq });

      const hello = setTimeout(
        () => end(again('Discord didn’t say Hello in time'), RECONNECT_CLOSE),
        this.waits.helloMs
      );

      signal.addEventListener('abort', stop);
      if (signal.aborted) {
        stop();
      }

      socket.addEventListener('message', (event) => {
        if (decided) {
          return;
        }
        let packet: { op?: number; d?: unknown; s?: number | null; t?: string };
        try {
          packet = JSON.parse(String(event.data));
        } catch {
          return;
        }

        switch (packet.op) {
          case GatewayOp.HELLO: {
            clearTimeout(hello);
            const interval =
              Number(
                (packet.d as { heartbeat_interval?: number })
                  ?.heartbeat_interval
              ) || 41_250;
            const next = (ms: number) => {
              beat = setTimeout(() => {
                // No ACK since the last beat: the connection is dead even if
                // it looks open, so start again.
                if (!acked) {
                  end(
                    again('Discord stopped answering heartbeats'),
                    RECONNECT_CLOSE
                  );
                  return;
                }
                acked = false;
                heartbeat();
                next(interval);
              }, ms);
            };
            next(interval * this.random());

            if (resume) {
              send({
                op: GatewayOp.RESUME,
                d: {
                  token: this.token,
                  session_id: this.sessionId,
                  seq: this.seq,
                },
              });
            } else {
              this.identified.lastAt = Date.now();
              send({
                op: GatewayOp.IDENTIFY,
                d: {
                  token: this.token,
                  intents: GATEWAY_INTENTS,
                  properties: {
                    os: process.platform,
                    browser: 'Seerr AI',
                    device: 'Seerr AI',
                  },
                },
              });
            }
            break;
          }
          case GatewayOp.HEARTBEAT_ACK:
            acked = true;
            break;
          case GatewayOp.HEARTBEAT:
            heartbeat();
            break;
          case GatewayOp.RECONNECT:
            end(
              again('Discord asked to reconnect', true, 'now'),
              RECONNECT_CLOSE
            );
            break;
          case GatewayOp.INVALID_SESSION: {
            // d says whether the session can still be resumed.
            const resumable = packet.d === true;
            end(
              again('Discord ended the session', resumable, 'invalidSession'),
              resumable ? RECONNECT_CLOSE : FINAL_CLOSE
            );
            break;
          }
          case GatewayOp.DISPATCH: {
            if (typeof packet.s === 'number') {
              this.seq = packet.s;
            }
            try {
              if (packet.t === 'READY') {
                const data = packet.d as {
                  session_id: string;
                  resume_gateway_url: string;
                  user?: GatewayUser;
                };
                this.sessionId = data.session_id;
                this.resumeUrl = data.resume_gateway_url;
                ready = true;
                this.hooks.onReady(data.user);
              } else if (packet.t === 'RESUMED') {
                ready = true;
                this.hooks.onReady();
              } else if (packet.t) {
                this.hooks.onDispatch(packet.t, packet.d);
              }
            } catch {
              // A hook's trouble is its own; the connection carries on.
            }
            break;
          }
        }
      });

      socket.addEventListener('close', (event) => {
        if (decided) {
          settle(decided);
          return;
        }
        const code = event.code ?? 1006;
        const detail = `Discord closed the connection (${code}${
          event.reason ? `: ${event.reason}` : ''
        })`;
        const refused = refusal(code);
        settle(
          refused
            ? { kind: 'refused', reason: refused, detail }
            : // Invalid seq, the session timed out, or a normal close
              // (which ends the session): start a new one.
              again(detail, ![1000, 1001, 4007, 4009].includes(code))
        );
      });

      // A close event always follows an error, and says what to do.
      socket.addEventListener('error', () => undefined);
    });
  }
}
