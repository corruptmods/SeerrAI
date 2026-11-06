import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { initI18n } from '@server/i18n';
import discordBot from '@server/lib/notifications/discordBot';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import settingsRoutes from '@server/routes/settings';
import {
  NEEDED_PERMISSIONS,
  channelPermissions,
} from '@server/routes/settings/discordBot';
import { setupTestDb } from '@server/test/db';
import type { RestAnswer, RestCall } from '@server/test/fakeDiscord';
import { fakeDiscordRest } from '@server/test/fakeDiscord';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  it,
  mock,
} from 'node:test';

/*
 * The Discord bot's setup steps, behind the real OpenAPI validator, with
 * Discord's REST API played by a fake fetch. The token must never come back.
 */

setupTestDb();

const TOKEN = 'MTAwMDAwMDAwMDAwMDAwMDAx.Gabcde.secret-part-of-the-token';
const BOT_ID = '100000000000000001';
const APP_ID = '100000000000000001';
const GUILD = '700000000000000007';
const EVERYONE = GUILD;
const BOT_ROLE = '710000000000000001';

let port = 0;
let server: Server;
let rest: ReturnType<typeof fakeDiscordRest>;
let answer: (call: RestCall) => RestAnswer | undefined;
/** Every body the API sent back, to check the token is in none. */
let answered: string[] = [];
const refresh = mock.method(discordBot, 'refresh', () => undefined);

const bot = getSettings().notifications.agents.discordBot;
const saved = structuredClone(bot);

const discord = (call: RestCall): RestAnswer => {
  const own = answer(call);
  if (own) {
    return own;
  }
  if (call.authorization !== `Bot ${TOKEN}`) {
    return { status: 401, body: { message: '401: Unauthorized', code: 0 } };
  }
  switch (`${call.method} ${call.path}`) {
    case 'GET /users/@me':
      return {
        body: {
          id: BOT_ID,
          username: 'glasswing',
          global_name: null,
          avatar: null,
        },
      };
    case 'GET /applications/@me':
      return {
        body: { id: APP_ID, name: 'Seerr AI', bot_require_code_grant: false },
      };
    case 'GET /users/@me/guilds':
      return { body: [{ id: GUILD, name: 'Static Garden', icon: 'abc' }] };
    case `GET /guilds/${GUILD}`:
      return {
        body: {
          id: GUILD,
          owner_id: '799999999999999999',
          roles: [
            // @everyone may view and read; the bot's role adds posting.
            { id: EVERYONE, permissions: String(1024 + 65536) },
            { id: BOT_ROLE, permissions: String(2048 + 16384) },
          ],
        },
      };
    case `GET /guilds/${GUILD}/members/${BOT_ID}`:
      return { body: { roles: [BOT_ROLE] } };
    case `GET /guilds/${GUILD}/channels`:
      return {
        body: [
          { id: '720000000000000002', name: 'Requests', type: 4, position: 1 },
          {
            id: '720000000000000003',
            name: 'approvals',
            type: 0,
            position: 0,
            parent_id: '720000000000000002',
          },
          {
            id: '720000000000000004',
            name: 'quiet',
            type: 0,
            position: 1,
            parent_id: '720000000000000002',
            // The bot's role may not send here.
            permission_overwrites: [
              { id: BOT_ROLE, type: 0, allow: '0', deny: '2048' },
            ],
          },
          { id: '720000000000000005', name: 'Lounge', type: 2, position: 2 },
          { id: '720000000000000006', name: 'general', type: 0, position: 0 },
        ],
      };
  }
  return { status: 404, body: { message: 'Unknown', code: 10003 } };
};

before(async () => {
  initI18n();
  const app = express();
  app.use(express.json());
  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateSecurity: false,
    })
  );
  app.use('/api/v1/settings', settingsRoutes);
  app.use(
    (
      err: { status?: number; message: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => res.status(err.status ?? 500).json({ message: err.message })
  );
  port = await new Promise<number>((resolve) => {
    server = http.createServer(app).listen(0, () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
});

after(() => server.close());

beforeEach(() => {
  answered = [];
  answer = () => undefined;
  refresh.mock.resetCalls();
  rest = fakeDiscordRest(discord);
  Object.assign(bot, structuredClone(saved));
});

afterEach(() => {
  rest.restore();
  Object.assign(bot, structuredClone(saved));
  for (const body of answered) {
    assert.ok(!body.includes('secret-part-of-the-token'), 'token sent back');
  }
});

const call = <T = Record<string, unknown>>(
  method: string,
  route: string,
  body?: unknown
) =>
  new Promise<{ status: number; body: T }>((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/api/v1/settings/notifications/discord-bot${route}`,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          answered.push(raw);
          resolve({
            status: res.statusCode ?? 0,
            body: raw ? JSON.parse(raw) : undefined,
          });
        });
      }
    );
    req.on('error', reject);
    req.end(payload);
  });

const withToken = () => {
  bot.options.botToken = TOKEN;
  bot.options.applicationId = APP_ID;
};

describe('Discord bot setup', () => {
  it('is off by default and says whether a token is saved, never the token', async () => {
    const off = await call('GET', '');
    assert.equal(off.status, 200);
    assert.deepEqual(off.body, {
      enabled: false,
      embedPoster: true,
      options: { botToken: '', applicationId: '', guildId: '', channelId: '' },
      hasBotToken: false,
      status: { state: 'off' },
    });

    withToken();
    const set = await call<{
      hasBotToken: boolean;
      options: { botToken: string };
    }>('GET', '');
    assert.equal(set.body.hasBotToken, true);
    assert.equal(set.body.options.botToken, '');
  });

  it('checks a token with Discord and keeps it only if it works', async () => {
    const refused = await call('PUT', '/token', {
      botToken: 'wrong.token.abcdefghijklmnopqrstuvwxyz',
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.reason, 'token');
    assert.equal(bot.options.botToken, '');

    const notOne = await call('PUT', '/token', { botToken: 'short' });
    assert.equal(notOne.status, 400);

    const ok = await call('PUT', '/token', { botToken: `  Bot ${TOKEN} ` });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, {
      bot: {
        id: BOT_ID,
        name: 'glasswing',
        // (id >> 22) % 6 for a bot with no avatar of its own.
        avatarUrl: `https://cdn.discordapp.com/embed/avatars/${Number(
          (BigInt(BOT_ID) >> BigInt(22)) % BigInt(6)
        )}.png`,
      },
      applicationId: APP_ID,
      applicationName: 'Seerr AI',
      inviteUrl: `https://discord.com/oauth2/authorize?client_id=${APP_ID}&scope=bot&permissions=84992`,
      requiresCodeGrant: false,
      isPublic: false,
    });
    assert.equal(bot.options.botToken, TOKEN);
    assert.equal(bot.options.applicationId, APP_ID);
    assert.equal(refresh.mock.callCount(), 1);
    assert.deepEqual(
      rest.calls
        .slice(-2)
        .map((c) => c.path)
        .sort(),
      ['/applications/@me', '/users/@me']
    );
  });

  it('asks only for View Channel, Send Messages, Embed Links and Read Message History', () => {
    assert.equal(NEEDED_PERMISSIONS, BigInt(1024 + 2048 + 16384 + 65536));
    assert.equal(String(NEEDED_PERMISSIONS), '84992');
  });

  it('starts the later steps again for another application’s token', async () => {
    withToken();
    bot.enabled = true;
    bot.options.applicationId = '199999999999999999';
    bot.options.guildId = GUILD;
    bot.options.channelId = '720000000000000003';
    const forget = mock.method(discordBot, 'forgetMessages', async () => {});
    try {
      const ok = await call('PUT', '/token', { botToken: TOKEN });
      assert.equal(ok.status, 200);
      assert.deepEqual(
        [bot.enabled, bot.options.guildId, bot.options.channelId],
        [false, '', '']
      );
      // The old bot's messages can't be edited by this one.
      assert.equal(forget.mock.callCount(), 1);

      // The same application again keeps them.
      await call('PUT', '/token', { botToken: TOKEN });
      assert.equal(forget.mock.callCount(), 1);
    } finally {
      forget.mock.restore();
    }
  });

  it('flags a bot that needs a code grant, or that anyone could add', async () => {
    withToken();
    answer = (c) =>
      c.path === '/applications/@me'
        ? {
            body: {
              id: APP_ID,
              name: 'Seerr AI',
              bot_require_code_grant: true,
              bot_public: true,
            },
          }
        : undefined;
    const info = await call('GET', '/bot');
    assert.equal(info.body.requiresCodeGrant, true);
    assert.equal(info.body.isPublic, true);
  });

  it('says when Discord can’t be reached', async () => {
    withToken();
    answer = () => ({ status: 503, body: { message: 'Service Unavailable' } });
    const down = await call('GET', '/bot');
    assert.equal(down.status, 502);
    assert.equal(down.body.reason, 'unreachable');
  });

  it('needs a saved token for the later steps', async () => {
    for (const route of ['/bot', '/guilds', `/guilds/${GUILD}/channels`]) {
      const none = await call('GET', route);
      assert.equal(none.status, 400, route);
      assert.equal(none.body.reason, 'token');
    }
    assert.equal(rest.calls.length, 0);
  });

  it('lists the servers the bot is in', async () => {
    withToken();
    const guilds = await call('GET', '/guilds');
    assert.deepEqual(guilds.body, [
      {
        id: GUILD,
        name: 'Static Garden',
        iconUrl: `https://cdn.discordapp.com/icons/${GUILD}/abc.png?size=64`,
      },
    ]);
  });

  it('lists a server’s text channels in order, and where the bot can’t post', async () => {
    withToken();
    const channels = await call('GET', `/guilds/${GUILD}/channels`);
    assert.equal(channels.status, 200);
    assert.deepEqual(channels.body, [
      {
        id: '720000000000000006',
        name: 'general',
        category: null,
        canPost: true,
      },
      {
        id: '720000000000000003',
        name: 'approvals',
        category: 'Requests',
        canPost: true,
      },
      {
        id: '720000000000000004',
        name: 'quiet',
        category: 'Requests',
        canPost: false,
      },
    ]);

    const bad = await call('GET', '/guilds/not-a-server/channels');
    assert.equal(bad.status, 400);
  });

  it('still lists channels when the bot’s permissions can’t be worked out', async () => {
    withToken();
    answer = (c) =>
      c.path.startsWith(`/guilds/${GUILD}/members/`)
        ? { status: 403, body: { message: 'Missing Access', code: 50001 } }
        : undefined;
    const channels = await call<{ canPost: boolean | null }[]>(
      'GET',
      `/guilds/${GUILD}/channels`
    );
    assert.equal(channels.status, 200);
    assert.deepEqual(
      channels.body.map((c) => c.canPost),
      [null, null, null]
    );
  });

  it('works out channel permissions the way Discord does', () => {
    const guild = {
      id: EVERYONE,
      owner_id: '799999999999999999',
      roles: [
        { id: EVERYONE, permissions: '0' },
        { id: BOT_ROLE, permissions: String(84992) },
      ],
    };
    const member = { roles: [BOT_ROLE] };
    const channel = (overwrites: object[]) => ({
      id: '1',
      name: 'c',
      type: 0,
      permission_overwrites: overwrites as never,
    });
    // A role's deny beats @everyone's allow; the bot's own allow beats both.
    assert.equal(
      channelPermissions(
        guild,
        member,
        BOT_ID,
        channel([
          { id: EVERYONE, type: 0, allow: '2048', deny: '0' },
          { id: BOT_ROLE, type: 0, allow: '0', deny: '2048' },
        ])
      ) & BigInt(2048),
      BigInt(0)
    );
    assert.equal(
      channelPermissions(
        guild,
        member,
        BOT_ID,
        channel([
          { id: BOT_ROLE, type: 0, allow: '0', deny: '2048' },
          { id: BOT_ID, type: 1, allow: '2048', deny: '0' },
        ])
      ) & BigInt(2048),
      BigInt(2048)
    );
    // Administrator ignores overwrites.
    assert.equal(
      channelPermissions(
        { ...guild, roles: [...guild.roles, { id: '9', permissions: '8' }] },
        { roles: [BOT_ROLE, '9'] },
        BOT_ID,
        channel([{ id: EVERYONE, type: 0, allow: '0', deny: '84992' }])
      ) & NEEDED_PERMISSIONS,
      NEEDED_PERMISSIONS
    );
  });

  it('lists who can approve, and who has no ID or shares one', async () => {
    const make = (name: string, permissions: number, discordIds: string[]) =>
      getRepository(User).save(
        new User({
          email: `${name}@test.local`,
          plexUsername: name,
          username: name,
          permissions,
          avatar: '',
          settings: new UserSettings({ discordIds }),
        })
      );
    await make('glasswing', Permission.MANAGE_REQUESTS, ['600000000000000001']);
    await make('harbour', Permission.MANAGE_REQUESTS, ['600000000000000002']);
    await make('lantern', Permission.ADMIN, ['600000000000000002', 'nonsense']);
    await make('requester', Permission.REQUEST, ['600000000000000001']);

    const approvers = await call<
      { displayName: string; linked: boolean; shared: boolean }[]
    >('GET', '/approvers');
    const shown = Object.fromEntries(
      approvers.body.map((a) => [a.displayName, [a.linked, a.shared]])
    );
    assert.deepEqual(shown.glasswing, [true, false]);
    assert.deepEqual(shown.harbour, [false, true]);
    assert.deepEqual(shown.lantern, [false, true]);
    // The seeded owner, with no ID.
    assert.deepEqual(shown.admin, [false, false]);
    assert.equal(shown.requester, undefined);
  });

  it('sends a test message whose buttons only say it’s a test', async () => {
    withToken();
    answer = (c) =>
      c.method === 'POST' ? { body: { id: '730000000000000001' } } : undefined;
    const sent = await call('POST', '/test', {
      channelId: '720000000000000003',
    });
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.body, { messageId: '730000000000000001' });
    const [post] = rest.calls;
    assert.equal(post.path, '/channels/720000000000000003/messages');
    assert.deepEqual(
      (
        post.body?.components as { components: { custom_id: string }[] }[]
      )[0].components.map((button) => button.custom_id),
      ['sai:test:approve', 'sai:test:decline']
    );
  });

  it('explains why a test message wasn’t sent', async () => {
    withToken();
    answer = (c) =>
      c.method === 'POST'
        ? { status: 403, body: { message: 'Missing Permissions', code: 50013 } }
        : undefined;
    const refused = await call('POST', '/test', {
      channelId: '720000000000000004',
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.reason, 'permissions');
    assert.equal(refused.body.detail, 'Missing Permissions');

    const invalid = await call('POST', '/test', { channelId: 'general' });
    assert.equal(invalid.status, 400);
  });

  it('turns on only once set up, and reconnects to match', async () => {
    const early = await call('POST', '', {
      enabled: true,
      embedPoster: true,
      options: { guildId: GUILD, channelId: '720000000000000003' },
    });
    assert.equal(early.status, 400);
    assert.equal(bot.enabled, false);

    withToken();
    const on = await call('POST', '', {
      enabled: true,
      embedPoster: false,
      options: { guildId: GUILD, channelId: '720000000000000003' },
    });
    assert.equal(on.status, 200);
    assert.equal(on.body.enabled, true);
    assert.equal(bot.embedPoster, false);
    assert.equal(bot.options.channelId, '720000000000000003');
    assert.equal(bot.options.botToken, TOKEN);
    assert.equal(refresh.mock.callCount(), 1);

    // The validator refuses what isn't an ID.
    const wrong = await call('POST', '', {
      enabled: false,
      embedPoster: true,
      options: { guildId: 'abc', channelId: '' },
    });
    assert.equal(wrong.status, 400);
  });
});
