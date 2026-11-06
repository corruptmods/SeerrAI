import type {
  GatewayHooks,
  GatewaySocketConstructor,
  GatewayUser,
} from '@server/lib/notifications/discordBot/gateway';
import {
  DEFAULT_GATEWAY_WAITS,
  Gateway,
  GatewayOp,
} from '@server/lib/notifications/discordBot/gateway';
import type { RestCall } from '@server/test/fakeDiscord';
import { FakeSocket, fakeDiscordRest, until } from '@server/test/fakeDiscord';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

/*
 * The Gateway connection against a socket the test plays Discord on: Hello,
 * heartbeats and their ACKs, Identify and Resume, Discord's requests to
 * reconnect, invalid sessions and close codes.
 */

const TOKEN = 'test-bot-token.abcdefghijklmnopqrstuvwxyz';

const waits = {
  ...DEFAULT_GATEWAY_WAITS,
  retryMs: 1,
  longestMs: 5,
  closeMs: 50,
  identifyGapMs: 0,
  invalidSessionMs: [0, 0] as [number, number],
};

let rest: ReturnType<typeof fakeDiscordRest>;
let gatewayAnswer: (call: RestCall) => { status?: number; body?: unknown };

beforeEach(() => {
  FakeSocket.reset();
  gatewayAnswer = () => ({
    body: {
      url: 'wss://gateway.test',
      session_start_limit: { remaining: 1000, reset_after: 0 },
    },
  });
  rest = fakeDiscordRest((call) =>
    call.path === '/gateway/bot' ? gatewayAnswer(call) : { status: 404 }
  );
});

afterEach(() => rest.restore());

const start = (heartbeatJitter = 0) => {
  const events: string[] = [];
  const users: (GatewayUser | undefined)[] = [];
  const dispatches: { event: string; data: unknown }[] = [];
  const hooks: GatewayHooks = {
    onReady: (user) => {
      users.push(user);
      events.push(user ? 'ready' : 'resumed');
    },
    onDispatch: (event, data) => dispatches.push({ event, data }),
    onTrouble: (detail) => events.push(`trouble: ${detail}`),
  };
  const controller = new AbortController();
  const gateway = new Gateway(
    TOKEN,
    hooks,
    FakeSocket as unknown as GatewaySocketConstructor,
    waits,
    () => heartbeatJitter
  );
  const finished = gateway.run(controller.signal);
  return { controller, finished, events, users, dispatches };
};

const socket = async (n: number) => {
  await until(() => FakeSocket.all.length >= n, `socket ${n}`);
  return FakeSocket.all[n - 1];
};

/** Hello and READY on a fresh connection. */
const handshake = async (ws: FakeSocket, interval = 10_000) => {
  ws.receive({ op: GatewayOp.HELLO, d: { heartbeat_interval: interval } });
  await until(() => ws.sentOps(GatewayOp.IDENTIFY).length > 0, 'Identify');
  ws.receive({
    op: GatewayOp.DISPATCH,
    t: 'READY',
    s: 1,
    d: {
      session_id: 'session-1',
      resume_gateway_url: 'wss://resume.test',
      user: { id: '100000000000000001', username: 'Glasswing Bot' },
    },
  });
};

describe('the Discord Gateway', () => {
  it('asks Discord where to connect, then identifies with the token and no intents', async () => {
    const run = start();
    const ws = await socket(1);
    assert.equal(ws.url, 'wss://gateway.test/?v=10&encoding=json');
    assert.equal(rest.calls[0].authorization, `Bot ${TOKEN}`);

    await handshake(ws);
    const [identify] = ws.sentOps(GatewayOp.IDENTIFY);
    assert.deepEqual(
      {
        token: (identify.d as { token: string }).token,
        intents: (identify.d as { intents: number }).intents,
      },
      { token: TOKEN, intents: 0 }
    );
    assert.deepEqual(run.events, ['ready']);
    assert.equal(run.users[0]?.username, 'Glasswing Bot');

    run.controller.abort();
    assert.deepEqual(await run.finished, { kind: 'stopped' });
    // Closed as final, so Discord drops the session and shows it offline.
    assert.equal(ws.closedWith, 1000);
  });

  it('heartbeats with the last sequence number, at a random point first, then every interval', async () => {
    // Jitter 0.5 of a 40 ms interval: the first beat after about 20 ms.
    const run = start(0.5);
    const ws = await socket(1);
    await handshake(ws, 40);
    ws.receive({ op: GatewayOp.DISPATCH, t: 'TYPING_START', s: 7, d: {} });

    await until(() => ws.sentOps(GatewayOp.HEARTBEAT).length === 1, 'beat');
    assert.equal(ws.sentOps(GatewayOp.HEARTBEAT)[0].d, 7);
    ws.receive({ op: GatewayOp.HEARTBEAT_ACK });
    await until(() => ws.sentOps(GatewayOp.HEARTBEAT).length === 2, 'beat 2');
    ws.receive({ op: GatewayOp.HEARTBEAT_ACK });

    // Discord can ask for one at once, too.
    const before = ws.sentOps(GatewayOp.HEARTBEAT).length;
    ws.receive({ op: GatewayOp.HEARTBEAT });
    assert.equal(ws.sentOps(GatewayOp.HEARTBEAT).length, before + 1);

    assert.equal(ws.isOpen, true);
    assert.equal(FakeSocket.all.length, 1);
    assert.deepEqual(run.dispatches, [{ event: 'TYPING_START', data: {} }]);
    run.controller.abort();
    await run.finished;
  });

  it('reconnects and resumes when a heartbeat goes unanswered', async () => {
    const run = start();
    const first = await socket(1);
    await handshake(first, 20);
    first.receive({ op: GatewayOp.DISPATCH, t: 'X', s: 4, d: {} });

    // The first beat goes at once (jitter 0); no ACK comes back.
    const second = await socket(2);
    assert.equal(first.closedWith, 4000);
    assert.equal(first.isOpen, false);
    assert.equal(second.url, 'wss://resume.test/?v=10&encoding=json');

    second.receive({ op: GatewayOp.HELLO, d: { heartbeat_interval: 10_000 } });
    await until(() => second.sentOps(GatewayOp.RESUME).length > 0, 'Resume');
    assert.deepEqual(second.sentOps(GatewayOp.RESUME)[0].d, {
      token: TOKEN,
      session_id: 'session-1',
      seq: 4,
    });
    assert.equal(second.sentOps(GatewayOp.IDENTIFY).length, 0);
    second.receive({ op: GatewayOp.DISPATCH, t: 'RESUMED', s: 5, d: {} });
    await until(() => run.events.includes('resumed'), 'resumed');
    assert.ok(
      run.events.includes('trouble: Discord stopped answering heartbeats')
    );
    assert.equal(FakeSocket.mostOpen, 1);

    run.controller.abort();
    await run.finished;
  });

  it('resumes straight away when Discord asks it to reconnect', async () => {
    const run = start();
    const first = await socket(1);
    await handshake(first);
    first.receive({ op: GatewayOp.RECONNECT });

    const second = await socket(2);
    assert.equal(first.closedWith, 4000);
    second.receive({ op: GatewayOp.HELLO, d: { heartbeat_interval: 10_000 } });
    await until(() => second.sentOps(GatewayOp.RESUME).length > 0, 'Resume');
    assert.equal(FakeSocket.mostOpen, 1);
    run.controller.abort();
    await run.finished;
  });

  it('starts a new session after an Invalid Session that can’t be resumed', async () => {
    const run = start();
    const first = await socket(1);
    await handshake(first);
    first.receive({ op: GatewayOp.INVALID_SESSION, d: false });

    const second = await socket(2);
    assert.equal(first.closedWith, 1000);
    // A new session starts from the address Discord gave at first.
    assert.equal(second.url, 'wss://gateway.test/?v=10&encoding=json');
    second.receive({ op: GatewayOp.HELLO, d: { heartbeat_interval: 10_000 } });
    await until(
      () => second.sentOps(GatewayOp.IDENTIFY).length > 0,
      'Identify'
    );
    assert.equal(second.sentOps(GatewayOp.RESUME).length, 0);
    run.controller.abort();
    await run.finished;
  });

  it('resumes after an Invalid Session that can be', async () => {
    const run = start();
    const first = await socket(1);
    await handshake(first);
    first.receive({ op: GatewayOp.INVALID_SESSION, d: true });

    const second = await socket(2);
    assert.equal(first.closedWith, 4000);
    second.receive({ op: GatewayOp.HELLO, d: { heartbeat_interval: 10_000 } });
    await until(() => second.sentOps(GatewayOp.RESUME).length > 0, 'Resume');
    run.controller.abort();
    await run.finished;
  });

  it('resumes after the connection drops, and identifies anew after 4009', async () => {
    const run = start();
    const first = await socket(1);
    await handshake(first);
    first.drop(1006);

    const second = await socket(2);
    second.receive({ op: GatewayOp.HELLO, d: { heartbeat_interval: 10_000 } });
    await until(() => second.sentOps(GatewayOp.RESUME).length > 0, 'Resume');

    // Session timed out: it can't be resumed.
    second.drop(4009, 'Session timed out');
    const third = await socket(3);
    assert.equal(third.url, 'wss://gateway.test/?v=10&encoding=json');
    third.receive({ op: GatewayOp.HELLO, d: { heartbeat_interval: 10_000 } });
    await until(() => third.sentOps(GatewayOp.IDENTIFY).length > 0, 'Identify');
    assert.ok(
      run.events.includes(
        'trouble: Discord closed the connection (4009: Session timed out)'
      )
    );
    run.controller.abort();
    await run.finished;
  });

  it('identifies anew after a normal close, which ends the session', async () => {
    const run = start();
    const first = await socket(1);
    await handshake(first);
    first.drop(1001, 'Going away');

    const second = await socket(2);
    assert.equal(second.url, 'wss://gateway.test/?v=10&encoding=json');
    second.receive({ op: GatewayOp.HELLO, d: { heartbeat_interval: 10_000 } });
    await until(
      () => second.sentOps(GatewayOp.IDENTIFY).length > 0,
      'Identify'
    );
    assert.equal(second.sentOps(GatewayOp.RESUME).length, 0);
    run.controller.abort();
    await run.finished;
  });

  it('stops for good when Discord refuses the token (4004), without trying again', async () => {
    const run = start();
    const ws = await socket(1);
    ws.receive({ op: GatewayOp.HELLO, d: { heartbeat_interval: 10_000 } });
    ws.drop(4004, 'Authentication failed.');

    assert.deepEqual(await run.finished, {
      kind: 'refused',
      reason: 'token',
      detail: 'Discord closed the connection (4004: Authentication failed.)',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(FakeSocket.all.length, 1);
  });

  it('stops for good on disallowed intents (4014)', async () => {
    const run = start();
    const ws = await socket(1);
    ws.drop(4014, 'Disallowed intent(s).');
    const end = await run.finished;
    assert.equal(end.kind, 'refused');
    assert.equal(end.kind === 'refused' && end.reason, 'intents');
  });

  it('stops without connecting when Discord refuses the token up front', async () => {
    gatewayAnswer = () => ({
      status: 401,
      body: { message: '401: Unauthorized', code: 0 },
    });
    const run = start();
    assert.deepEqual(await run.finished, {
      kind: 'refused',
      reason: 'token',
      detail: '401: Unauthorized',
    });
    assert.equal(FakeSocket.all.length, 0);
  });

  it('tries again when Discord can’t be reached, then connects', async () => {
    let failures = 2;
    gatewayAnswer = () =>
      failures-- > 0
        ? { status: 502, body: { message: 'Bad Gateway' } }
        : { body: { url: 'wss://gateway.test' } };
    const run = start();
    const ws = await socket(1);
    assert.equal(
      rest.calls.filter((call) => call.path === '/gateway/bot').length,
      3
    );
    assert.equal(run.events.filter((e) => e.startsWith('trouble')).length, 2);
    run.controller.abort();
    await run.finished;
    assert.equal(ws.closedWith, 1000);
  });

  it('gives up on a connection that never says Hello', async () => {
    const controller = new AbortController();
    const gateway = new Gateway(
      TOKEN,
      {
        onReady: () => undefined,
        onDispatch: () => undefined,
        onTrouble: () => undefined,
      },
      FakeSocket as unknown as GatewaySocketConstructor,
      { ...waits, helloMs: 10 }
    );
    const finished = gateway.run(controller.signal);
    const first = await socket(1);
    await socket(2);
    assert.equal(first.closedWith, 4000);
    controller.abort();
    await finished;
  });
});
