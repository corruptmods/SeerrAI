import type { GatewaySocket } from '@server/lib/notifications/discordBot/gateway';
import { mock } from 'node:test';

/*
 * Stand-ins for Discord in tests: a Gateway socket driven by the test, and
 * fetch answering REST calls from a table. Nothing reaches the network.
 */

type Listener = (event: {
  data?: unknown;
  code?: number;
  reason?: string;
}) => void;

export class FakeSocket implements GatewaySocket {
  public static all: FakeSocket[] = [];
  /** The most sockets open at one time. */
  public static mostOpen = 0;

  public static reset(): void {
    FakeSocket.all = [];
    FakeSocket.mostOpen = 0;
  }

  public static get openNow(): FakeSocket[] {
    return FakeSocket.all.filter((socket) => socket.isOpen);
  }

  public sent: { op: number; d?: unknown }[] = [];
  /** The code this side closed with. */
  public closedWith?: number;
  public isOpen = true;
  private listeners = new Map<string, Listener[]>();

  public constructor(public readonly url: string) {
    FakeSocket.all.push(this);
    FakeSocket.mostOpen = Math.max(
      FakeSocket.mostOpen,
      FakeSocket.openNow.length
    );
  }

  public addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  public send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  public close(code?: number): void {
    if (!this.isOpen || this.closedWith !== undefined) {
      return;
    }
    this.closedWith = code;
    // As a real socket: closed a moment later.
    setTimeout(() => this.closed(code ?? 1005, ''), 1);
  }

  /** Discord sends a packet. */
  public receive(packet: object): void {
    this.emit('message', { data: JSON.stringify(packet) });
  }

  /** Discord closes the connection. */
  public drop(code: number, reason = ''): void {
    this.closed(code, reason);
  }

  public sentOps(op: number) {
    return this.sent.filter((packet) => packet.op === op);
  }

  private closed(code: number, reason: string) {
    if (!this.isOpen) {
      return;
    }
    this.isOpen = false;
    this.emit('close', { code, reason });
  }

  private emit(type: string, event: Parameters<Listener>[0]) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

export interface RestCall {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  authorization?: string;
}

export type RestAnswer = { status?: number; body?: unknown };

/**
 * Replaces fetch for Discord's REST API. `answer` decides each reply; every
 * call is kept in `calls`.
 */
export const fakeDiscordRest = (
  answer: (call: RestCall) => RestAnswer | Promise<RestAnswer>
) => {
  const calls: RestCall[] = [];
  const fetchMock = mock.method(
    globalThis,
    'fetch',
    async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.host !== 'discord.com') {
        throw new Error(`unexpected fetch to ${url.host}`);
      }
      const headers = new Headers(init?.headers);
      const call: RestCall = {
        method: init?.method ?? 'GET',
        path: url.pathname.replace(/^\/api\/v10/, '') + url.search,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        authorization: headers.get('authorization') ?? undefined,
      };
      calls.push(call);
      const { status = 200, body } = await answer(call);
      return new Response(
        status === 204 || body === undefined ? null : JSON.stringify(body),
        { status, headers: { 'Content-Type': 'application/json' } }
      );
    }
  );
  return { calls, restore: () => fetchMock.mock.restore() };
};

export const until = async (condition: () => boolean, what: string) => {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > 5000) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};
