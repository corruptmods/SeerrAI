import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import DiscordApprovalMessage from '@server/entity/DiscordApprovalMessage';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { initI18n } from '@server/i18n';
import { Notification } from '@server/lib/notifications';
import DiscordBotAgent from '@server/lib/notifications/agents/discordBot';
import type { Interaction } from '@server/lib/notifications/discordBot';
import discordBot from '@server/lib/notifications/discordBot';
import type { GatewaySocketConstructor } from '@server/lib/notifications/discordBot/gateway';
import { GatewayOp } from '@server/lib/notifications/discordBot/gateway';
import { Permission } from '@server/lib/permissions';
import { changeRequestStatus } from '@server/lib/requestStatusChange';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import type { RestAnswer, RestCall } from '@server/test/fakeDiscord';
import { FakeSocket, fakeDiscordRest, until } from '@server/test/fakeDiscord';
import assert from 'node:assert/strict';
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
 * The Discord bot: connecting with the settings, button presses, and posting
 * requests waiting for approval. Discord is played by a fake Gateway socket
 * and a fake fetch; nothing reaches the network.
 */

setupTestDb();

mock.method(MediaRequest, 'sendNotification', async () => true);

Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  configurable: true,
  set() {},
  get() {
    return async () => ({
      id: 1,
      title: 'Static Garden',
      release_date: '2020-01-01',
    });
  },
});

const TOKEN = 'bot-token.abcdefghijklmnopqrstuvwxyz0123';
const OTHER_TOKEN = 'other-token.abcdefghijklmnopqrstuvwxyz01';
const CHANNEL = '200000000000000002';
const GUILD = '100000000000000001';
const APP = '300000000000000003';

let rest: ReturnType<typeof fakeDiscordRest>;
let answer: (call: RestCall) => RestAnswer | Promise<RestAnswer> | undefined;

const bot = getSettings().notifications.agents.discordBot;
const saved = {
  bot: structuredClone(bot),
  waits: { ...discordBot.waits },
  Socket: discordBot.Socket,
  random: discordBot.random,
};

before(() => {
  initI18n();
});

beforeEach(() => {
  FakeSocket.reset();
  answer = () => undefined;
  rest = fakeDiscordRest(async (call) => {
    const own = answer(call);
    if (own) {
      return own;
    }
    if (call.path === '/gateway/bot') {
      return { body: { url: 'wss://gateway.test' } };
    }
    if (call.path.startsWith('/interactions/')) {
      return { status: 204 };
    }
    if (call.method === 'POST' && call.path.startsWith('/channels/')) {
      return { body: { id: '400000000000000004', channel_id: CHANNEL } };
    }
    return { body: {} };
  });
  Object.assign(discordBot.waits, {
    retryMs: 1,
    longestMs: 5,
    closeMs: 50,
    identifyGapMs: 0,
    invalidSessionMs: [0, 0],
  });
  discordBot.Socket = FakeSocket as unknown as GatewaySocketConstructor;
  discordBot.random = () => 0.99;
});

afterEach(async () => {
  await discordBot.stop();
  rest.restore();
  Object.assign(bot, structuredClone(saved.bot));
  Object.assign(discordBot.waits, saved.waits);
  discordBot.Socket = saved.Socket;
  discordBot.random = saved.random;
});

after(async () => {
  await discordBot.stop();
});

const configure = (token = TOKEN, enabled = true) => {
  bot.enabled = enabled;
  bot.options = {
    botToken: token,
    applicationId: APP,
    guildId: '100000000000000001',
    channelId: CHANNEL,
  };
};

const makeUser = (
  name: string,
  permissions: number,
  discordIds: string[] = []
) =>
  getRepository(User).save(
    new User({
      email: `${name}@test.local`,
      plexUsername: name,
      permissions,
      avatar: '',
      settings: new UserSettings({ discordIds }),
    })
  );

const seedPending = async (tmdbId = 8401) => {
  const requester = await makeUser(`req${tmdbId}`, Permission.REQUEST);
  const media = await getRepository(Media).save(
    new Media({
      tmdbId,
      mediaType: MediaType.MOVIE,
      status: MediaStatus.PENDING,
    })
  );
  return getRepository(MediaRequest).save(
    new MediaRequest({
      media,
      requestedBy: requester,
      type: MediaType.MOVIE,
      status: MediaRequestStatus.PENDING,
      is4k: false,
    })
  );
};

const stored = (id: number) =>
  getRepository(MediaRequest).findOneOrFail({
    where: { id },
    relations: { modifiedBy: true },
  });

const EMBED = {
  title: 'New Movie Request: Harbour Lights (2020)',
  color: 15105570,
  fields: [
    { name: 'Requested By', value: 'someone', inline: true },
    { name: 'Request Status', value: '[Pending Approval](x)', inline: true },
  ],
  thumbnail: { url: 'https://image.test/p.jpg', proxy_url: 'p', width: 1 },
  type: 'rich' as const,
};

const press = (
  presser: string,
  customId: string,
  extra: Partial<Interaction> = {}
): Interaction => ({
  id: '500000000000000005',
  application_id: APP,
  type: 3,
  token: 'interaction-token',
  guild_id: GUILD,
  data: { custom_id: customId },
  member: { user: { id: presser } },
  message: { id: '400000000000000004', channel_id: CHANNEL, embeds: [EMBED] },
  ...extra,
});

const callbacks = () =>
  rest.calls.filter((call) => call.path.startsWith('/interactions/'));
const followUps = () =>
  rest.calls
    .filter(
      (call) =>
        call.method === 'POST' &&
        call.path === `/webhooks/${APP}/interaction-token`
    )
    .map((call) => call.body);
const edits = () =>
  rest.calls.filter(
    (call) =>
      call.method === 'PATCH' && call.path.endsWith('/messages/@original')
  );

describe('the Discord bot’s connection', () => {
  it('stays off until it’s turned on with a token and a channel', async () => {
    configure(TOKEN, false);
    discordBot.refresh();
    bot.enabled = true;
    bot.options.channelId = '';
    discordBot.refresh();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(FakeSocket.all.length, 0);
    assert.deepEqual(discordBot.status, { state: 'off' });
  });

  it('connects, says so, and disconnects when turned off', async () => {
    configure();
    discordBot.refresh();
    assert.deepEqual(discordBot.status, { state: 'connecting' });
    await until(() => FakeSocket.all.length === 1, 'socket');
    const ws = FakeSocket.all[0];
    ws.receive({ op: GatewayOp.HELLO, d: { heartbeat_interval: 10_000 } });
    ws.receive({
      op: GatewayOp.DISPATCH,
      t: 'READY',
      s: 1,
      d: {
        session_id: 's',
        resume_gateway_url: 'wss://resume.test',
        user: { id: '1', username: 'lantern', global_name: 'Lantern Song' },
      },
    });
    assert.deepEqual(discordBot.status, {
      state: 'connected',
      botName: 'Lantern Song',
    });

    // Saving with nothing changed leaves the connection alone.
    discordBot.refresh();
    assert.equal(FakeSocket.all.length, 1);

    bot.enabled = false;
    discordBot.refresh();
    await until(() => !ws.isOpen, 'closed');
    assert.equal(ws.closedWith, 1000);
    assert.deepEqual(discordBot.status, { state: 'off' });
  });

  it('reconnects with a new token only once the old connection has closed', async () => {
    configure();
    discordBot.refresh();
    await until(() => FakeSocket.all.length === 1, 'first socket');

    bot.options.botToken = OTHER_TOKEN;
    discordBot.refresh();
    bot.options.botToken = TOKEN;
    discordBot.refresh();
    bot.options.botToken = OTHER_TOKEN;
    discordBot.refresh();

    await until(
      () => FakeSocket.openNow.length === 1 && FakeSocket.all.length > 1,
      'new socket'
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(FakeSocket.mostOpen, 1);
    const last = FakeSocket.all.at(-1)!;
    last.receive({ op: GatewayOp.HELLO, d: { heartbeat_interval: 10_000 } });
    await until(() => last.sentOps(GatewayOp.IDENTIFY).length > 0, 'identify');
    assert.equal(
      (last.sentOps(GatewayOp.IDENTIFY)[0].d as { token: string }).token,
      OTHER_TOKEN
    );
    assert.equal(FakeSocket.openNow.length, 1);
  });

  it('stops on a refused token and says why, and tries again when saved', async () => {
    configure();
    discordBot.refresh();
    await until(() => FakeSocket.all.length === 1, 'socket');
    FakeSocket.all[0].drop(4004, 'Authentication failed.');
    await until(() => discordBot.status.state === 'refused', 'refused');
    assert.equal(
      discordBot.status.state === 'refused' && discordBot.status.reason,
      'token'
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(FakeSocket.all.length, 1);

    discordBot.refresh();
    await until(() => FakeSocket.all.length === 2, 'retried');
    assert.equal(discordBot.status.state, 'connecting');
  });

  it('keeps Identifies apart across reconnects made by saving', async () => {
    discordBot.waits.identifyGapMs = 200;
    configure();
    discordBot.refresh();
    await until(() => FakeSocket.all.length === 1, 'socket');
    const first = FakeSocket.all[0];
    first.receive({ op: GatewayOp.HELLO, d: { heartbeat_interval: 10_000 } });
    await until(() => first.sentOps(GatewayOp.IDENTIFY).length > 0, 'identify');
    const identifiedAt = Date.now();

    bot.options.botToken = OTHER_TOKEN;
    discordBot.refresh();
    await until(() => FakeSocket.all.length === 2, 'second socket');
    assert.ok(Date.now() - identifiedAt >= 180);
  });

  it('shows a failed post in the status until a post works again', async () => {
    configure();
    discordBot.refresh();
    await until(() => FakeSocket.all.length === 1, 'socket');
    const ws = FakeSocket.all[0];
    ws.receive({ op: GatewayOp.HELLO, d: { heartbeat_interval: 10_000 } });
    ws.receive({
      op: GatewayOp.DISPATCH,
      t: 'READY',
      s: 1,
      d: {
        session_id: 's',
        resume_gateway_url: 'wss://resume.test',
        user: { id: '1', username: 'lantern' },
      },
    });
    const pending = await seedPending();
    const request = await getRepository(MediaRequest).findOneOrFail({
      where: { id: pending.id },
      relations: { requestedBy: true, media: true },
    });
    const payload = {
      subject: 'Harbour Lights (2020)',
      notifySystem: true,
      notifyAdmin: true,
      media: request.media,
      request,
    };

    answer = (call) =>
      call.method === 'POST' && call.path.startsWith('/channels/')
        ? { status: 403, body: { message: 'Missing Permissions', code: 50013 } }
        : undefined;
    assert.equal(
      await new DiscordBotAgent().send(Notification.MEDIA_PENDING, payload),
      false
    );
    assert.deepEqual(discordBot.status, {
      state: 'postFailed',
      botName: 'lantern',
      reason: 'permissions',
      detail: 'Missing Permissions',
    });

    answer = () => undefined;
    await new DiscordBotAgent().send(Notification.MEDIA_PENDING, payload);
    assert.deepEqual(discordBot.status, {
      state: 'connected',
      botName: 'lantern',
    });
  });

  it('handles a press that arrives over the Gateway', async () => {
    configure();
    const pending = await seedPending();
    await makeUser('glasswing', Permission.MANAGE_REQUESTS, [
      '600000000000000006',
    ]);
    discordBot.refresh();
    await until(() => FakeSocket.all.length === 1, 'socket');
    const ws = FakeSocket.all[0];
    ws.receive({ op: GatewayOp.HELLO, d: { heartbeat_interval: 10_000 } });
    ws.receive({
      op: GatewayOp.DISPATCH,
      t: 'INTERACTION_CREATE',
      s: 2,
      d: press('600000000000000006', `sai:approve:${pending.id}`),
    });
    await until(() => edits().length === 1, 'edit');
    assert.equal(
      (await stored(pending.id)).status,
      MediaRequestStatus.APPROVED
    );
  });
});

describe('a Discord button press', () => {
  it('approves as the linked manager: acknowledged first, then the message shows who and loses its buttons', async () => {
    configure();
    const admin = await makeUser('glasswing', Permission.MANAGE_REQUESTS, [
      '600000000000000006',
    ]);
    const pending = await seedPending();
    await getRepository(DiscordApprovalMessage).save(
      new DiscordApprovalMessage({
        requestId: pending.id,
        channelId: CHANNEL,
        messageId: '400000000000000004',
      })
    );
    // What the request was when Discord got its answer.
    const statusWhenAnswered: MediaRequestStatus[] = [];
    answer = (call) =>
      call.path.startsWith('/interactions/')
        ? stored(pending.id).then(({ status }) => {
            statusWhenAnswered.push(status);
            return { status: 204 };
          })
        : undefined;

    await discordBot.handle(
      TOKEN,
      press('600000000000000006', `sai:approve:${pending.id}`)
    );

    const saved = await stored(pending.id);
    assert.equal(saved.status, MediaRequestStatus.APPROVED);
    assert.equal(saved.modifiedBy?.id, admin.id);

    const [callback] = callbacks();
    assert.equal(
      callback.path,
      '/interactions/500000000000000005/interaction-token/callback'
    );
    assert.deepEqual(callback.body, { type: 6 });
    // Discord was answered before the request was changed.
    assert.deepEqual(statusWhenAnswered, [MediaRequestStatus.PENDING]);

    const [edit] = edits();
    assert.equal(
      edit.path,
      `/webhooks/${APP}/interaction-token/messages/@original`
    );
    assert.deepEqual(edit.body?.components, []);
    const [embed] = edit.body?.embeds as {
      fields: { name: string; value: string }[];
      thumbnail: object;
      type?: string;
    }[];
    assert.deepEqual(embed.fields[1], {
      name: 'Request Status',
      value: 'Approved by glasswing',
      inline: true,
    });
    // Only what may be sent back.
    assert.deepEqual(embed.thumbnail, { url: 'https://image.test/p.jpg' });
    assert.equal(embed.type, undefined);

    assert.equal(
      await getRepository(DiscordApprovalMessage).count({
        where: { requestId: pending.id },
      }),
      0
    );
  });

  it('refuses someone not linked, privately, and changes nothing', async () => {
    configure();
    const pending = await seedPending();
    // Has the ID, but may not manage requests: doesn't count.
    await makeUser('harbour', Permission.REQUEST, ['600000000000000007']);

    await discordBot.handle(
      TOKEN,
      press('600000000000000007', `sai:approve:${pending.id}`)
    );

    assert.equal((await stored(pending.id)).status, MediaRequestStatus.PENDING);
    const [callback] = callbacks();
    assert.equal(callback.body?.type, 4);
    assert.deepEqual(callback.body?.data, {
      content:
        'You can’t approve requests here: this Discord account isn’t linked to a Seerr AI account that can manage requests',
      flags: 64,
    });
    assert.equal(edits().length, 0);
  });

  it('refuses when two managers have the same Discord ID', async () => {
    configure();
    const pending = await seedPending();
    await makeUser('one', Permission.MANAGE_REQUESTS, ['600000000000000008']);
    await makeUser('two', Permission.ADMIN, ['600000000000000008']);

    await discordBot.handle(
      TOKEN,
      press('600000000000000008', `sai:approve:${pending.id}`, {
        member: undefined,
        user: { id: '600000000000000008' },
      })
    );

    assert.equal((await stored(pending.id)).status, MediaRequestStatus.PENDING);
    const [callback] = callbacks();
    assert.match(
      (callback.body?.data as { content: string }).content,
      /linked to more than one Seerr AI account/
    );
    assert.equal((callback.body?.data as { flags: number }).flags, 64);
  });

  it('says a request was already approved, and takes the buttons away', async () => {
    configure();
    const admin = await makeUser('garden', Permission.MANAGE_REQUESTS, [
      '600000000000000009',
    ]);
    const pending = await seedPending();
    await changeRequestStatus(pending.id, 'approve', admin);

    await discordBot.handle(
      TOKEN,
      press('600000000000000009', `sai:decline:${pending.id}`)
    );

    assert.deepEqual(callbacks()[0].body, { type: 6 });
    const [edit] = edits();
    const [embed] = edit.body?.embeds as {
      fields: { value: string }[];
    }[];
    // Still names who approved it, and tells the presser privately.
    assert.equal(embed.fields[1].value, 'Approved by garden');
    assert.deepEqual(edit.body?.components, []);
    assert.deepEqual(followUps(), [
      { content: 'Already approved by garden', flags: 64 },
    ]);
    assert.equal(
      (await stored(pending.id)).status,
      MediaRequestStatus.APPROVED
    );
  });

  it('keeps the first approver’s name when a second manager presses too', async () => {
    configure();
    await makeUser('glasswing', Permission.MANAGE_REQUESTS, [
      '600000000000000021',
    ]);
    await makeUser('harbour', Permission.MANAGE_REQUESTS, [
      '600000000000000022',
    ]);
    const pending = await seedPending();

    await discordBot.handle(
      TOKEN,
      press('600000000000000021', `sai:approve:${pending.id}`)
    );
    await discordBot.handle(
      TOKEN,
      press('600000000000000022', `sai:approve:${pending.id}`)
    );

    const values = edits().map(
      (edit) =>
        (edit.body?.embeds as { fields: { value: string }[] }[])[0].fields[1]
          .value
    );
    assert.deepEqual(values, [
      'Approved by glasswing',
      'Approved by glasswing',
    ]);
    assert.deepEqual(followUps(), [
      { content: 'Already approved by glasswing', flags: 64 },
    ]);
    assert.equal(
      (await stored(pending.id)).modifiedBy?.displayName,
      'glasswing'
    );
  });

  it('takes the buttons off the request’s other messages too, leaving the pressed one to the press', async () => {
    configure();
    await makeUser('glasswing', Permission.MANAGE_REQUESTS, [
      '600000000000000023',
    ]);
    const pending = await seedPending();
    const repo = getRepository(DiscordApprovalMessage);
    await repo.save([
      new DiscordApprovalMessage({
        requestId: pending.id,
        channelId: CHANNEL,
        messageId: '400000000000000004',
      }),
      new DiscordApprovalMessage({
        requestId: pending.id,
        channelId: '200000000000000099',
        messageId: '400000000000000099',
      }),
    ]);
    answer = (call) =>
      call.method === 'GET'
        ? { body: { id: '400000000000000099', embeds: [EMBED] } }
        : undefined;

    await discordBot.handle(
      TOKEN,
      press('600000000000000023', `sai:approve:${pending.id}`)
    );

    const other = '/channels/200000000000000099/messages/400000000000000099';
    assert.deepEqual(
      rest.calls
        .filter((call) => call.path.startsWith('/channels/'))
        .map((call) => `${call.method} ${call.path}`),
      [`GET ${other}`, `PATCH ${other}`]
    );
    assert.equal(edits().length, 1);
    assert.equal(await repo.count(), 0);
  });

  it('refuses presses outside the chosen server or off the bot’s own messages', async () => {
    configure();
    await makeUser('glasswing', Permission.MANAGE_REQUESTS, [
      '600000000000000024',
    ]);
    const pending = await seedPending();
    const other = await seedPending(8402);
    await getRepository(DiscordApprovalMessage).save(
      new DiscordApprovalMessage({
        requestId: other.id,
        channelId: CHANNEL,
        messageId: '400000000000000004',
      })
    );
    const id = `sai:approve:${pending.id}`;
    const elsewhere = {
      id: '400000000000000050',
      channel_id: '200000000000000050',
      embeds: [EMBED],
    };

    // Another server, a direct message, a message kept for another request,
    // a message the bot doesn't keep outside its channel.
    await discordBot.handle(
      TOKEN,
      press('600000000000000024', id, { guild_id: '199999999999999999' })
    );
    await discordBot.handle(
      TOKEN,
      press('600000000000000024', id, { guild_id: undefined })
    );
    await discordBot.handle(TOKEN, press('600000000000000024', id));
    await discordBot.handle(
      TOKEN,
      press('600000000000000024', id, { message: elsewhere })
    );
    await discordBot.handle(
      TOKEN,
      press('600000000000000024', 'sai:test:approve', {
        guild_id: '199999999999999999',
      })
    );

    const answers = callbacks().map(
      (call) => (call.body?.data as { content: string }).content
    );
    assert.equal(answers.length, 5);
    for (const content of answers) {
      assert.equal(
        content,
        'These buttons only work on Seerr AI’s own messages in its chosen server'
      );
    }
    assert.equal((await stored(pending.id)).status, MediaRequestStatus.PENDING);
    assert.equal(edits().length, 0);
  });

  it('tells the presser when approving fails, after acknowledging', async () => {
    configure();
    await makeUser('glasswing', Permission.MANAGE_REQUESTS, [
      '600000000000000025',
    ]);
    const pending = await seedPending();
    const save = mock.method(getRepository(MediaRequest), 'save', async () => {
      throw new Error('disk full');
    });
    try {
      await discordBot.handle(
        TOKEN,
        press('600000000000000025', `sai:approve:${pending.id}`)
      );
    } finally {
      save.mock.restore();
    }
    assert.deepEqual(callbacks()[0].body, { type: 6 });
    assert.deepEqual(followUps(), [
      {
        content: 'Something went wrong. Try again in Seerr AI.',
        flags: 64,
      },
    ]);
    assert.equal((await stored(pending.id)).status, MediaRequestStatus.PENDING);
  });

  it('doesn’t wait long on a 429 when answering a press', async () => {
    configure();
    const pending = await seedPending();
    answer = (call) =>
      call.path.startsWith('/interactions/')
        ? { status: 429, body: { message: 'slow down', retry_after: 2 } }
        : undefined;
    const started = Date.now();
    await assert.rejects(
      discordBot.handle(
        TOKEN,
        press('600000000000000026', `sai:approve:${pending.id}`)
      )
    );
    assert.equal(callbacks().length, 1);
    assert.ok(Date.now() - started < 1000);
  });

  it('ignores a request id too large to be one', async () => {
    configure();
    await discordBot.handle(
      TOKEN,
      press('600000000000000011', 'sai:approve:2147483648')
    );
    assert.deepEqual(
      callbacks().map((call) => call.body),
      [{ type: 6 }]
    );
  });

  it('asks for a reason on Decline, then declines with it', async () => {
    configure();
    await makeUser('lantern', Permission.MANAGE_REQUESTS, [
      '600000000000000010',
    ]);
    const pending = await seedPending();

    await discordBot.handle(
      TOKEN,
      press('600000000000000010', `sai:decline:${pending.id}`)
    );
    const [modal] = callbacks();
    assert.equal(modal.body?.type, 9);
    const form = modal.body?.data as {
      custom_id: string;
      title: string;
      components: { components: { custom_id: string; required: boolean }[] }[];
    };
    assert.equal(form.custom_id, `sai:reason:${pending.id}`);
    assert.equal(form.title, 'Decline Request');
    assert.equal(form.components[0].components[0].custom_id, 'reason');
    assert.equal(form.components[0].components[0].required, false);
    assert.equal((await stored(pending.id)).status, MediaRequestStatus.PENDING);

    await discordBot.handle(
      TOKEN,
      press('600000000000000010', `sai:reason:${pending.id}`, {
        type: 5,
        data: {
          custom_id: `sai:reason:${pending.id}`,
          components: [
            {
              type: 1,
              components: [
                { type: 4, custom_id: 'reason', value: '  Already on disc  ' },
              ],
            },
          ],
        },
      })
    );

    const declined = await stored(pending.id);
    assert.equal(declined.status, MediaRequestStatus.DECLINED);
    assert.equal(declined.declineReason, 'Already on disc');
    assert.deepEqual(callbacks()[1].body, { type: 6 });
    const [embed] = edits()[0].body?.embeds as {
      fields: { value: string }[];
      color: number;
    }[];
    assert.equal(embed.fields[1].value, 'Declined by lantern');
    assert.equal(embed.color, 15158332);
  });

  it('declines with no reason when the form is left blank', async () => {
    configure();
    await makeUser('lantern', Permission.MANAGE_REQUESTS, [
      '600000000000000010',
    ]);
    const pending = await seedPending();
    await discordBot.handle(
      TOKEN,
      press('600000000000000010', `sai:reason:${pending.id}`, {
        type: 5,
        data: {
          custom_id: `sai:reason:${pending.id}`,
          components: [
            {
              type: 1,
              components: [{ type: 4, custom_id: 'reason', value: '   ' }],
            },
          ],
        },
      })
    );
    const declined = await stored(pending.id);
    assert.equal(declined.status, MediaRequestStatus.DECLINED);
    assert.equal(declined.declineReason, null);
  });

  it('answers the test message’s buttons with only a word, linked or not', async () => {
    configure();
    await makeUser('glasswing', Permission.MANAGE_REQUESTS, [
      '600000000000000011',
    ]);

    await discordBot.handle(
      TOKEN,
      press('600000000000000011', 'sai:test:approve')
    );
    await discordBot.handle(
      TOKEN,
      press('600000000000000012', 'sai:test:decline')
    );

    const [linked, stranger] = callbacks().map(
      (call) => call.body?.data as { content: string; flags: number }
    );
    assert.deepEqual(linked, {
      content:
        'This is a test, so nothing changed. This Discord account can approve requests as glasswing in Seerr AI.',
      flags: 64,
    });
    assert.match(
      stranger.content,
      /^This is a test, so nothing changed\. You can’t approve/
    );
    assert.equal(edits().length, 0);
  });

  it('acknowledges presses that aren’t its own and does nothing', async () => {
    configure();
    await discordBot.handle(TOKEN, press('600000000000000011', 'other:thing'));
    await discordBot.handle(
      TOKEN,
      press('600000000000000011', 'sai:approve:abc')
    );
    assert.deepEqual(
      callbacks().map((call) => call.body),
      [{ type: 6 }, { type: 6 }]
    );
  });
});

describe('the Discord bot’s messages', () => {
  const payloadFor = (request: MediaRequest, media: Media) => ({
    subject: 'Harbour Lights (2020)',
    message: 'A lighthouse keeper.',
    image: 'https://image.test/poster.jpg',
    notifySystem: true,
    notifyAdmin: true,
    media,
    request,
  });

  it('posts a request waiting for approval with Approve and Decline, and remembers where', async () => {
    configure();
    const pending = await seedPending();
    const request = await getRepository(MediaRequest).findOneOrFail({
      where: { id: pending.id },
      relations: { requestedBy: true, media: true },
    });
    const agent = new DiscordBotAgent();
    assert.equal(agent.shouldSend(), true);

    assert.equal(
      await agent.send(
        Notification.MEDIA_PENDING,
        payloadFor(request, request.media)
      ),
      true
    );

    const [post] = rest.calls.filter((call) => call.method === 'POST');
    assert.equal(post.path, `/channels/${CHANNEL}/messages`);
    assert.equal(post.authorization, `Bot ${TOKEN}`);
    assert.deepEqual(post.body?.allowed_mentions, { parse: [] });
    const [embed] = post.body?.embeds as {
      title: string;
      thumbnail?: { url: string };
      fields: { name: string; value: string }[];
    }[];
    assert.match(embed.title, /Harbour Lights \(2020\)/);
    assert.deepEqual(embed.thumbnail, { url: 'https://image.test/poster.jpg' });
    assert.equal(embed.fields[0].name, 'Requested By');
    assert.deepEqual(post.body?.components, [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 3,
            label: 'Approve',
            custom_id: `sai:approve:${pending.id}`,
          },
          {
            type: 2,
            style: 4,
            label: 'Decline',
            custom_id: `sai:decline:${pending.id}`,
          },
        ],
      },
    ]);

    const [kept] = await getRepository(DiscordApprovalMessage).find();
    assert.deepEqual(
      {
        requestId: kept.requestId,
        channelId: kept.channelId,
        messageId: kept.messageId,
      },
      {
        requestId: pending.id,
        channelId: CHANNEL,
        messageId: '400000000000000004',
      }
    );
  });

  it('leaves out the poster when Embed Poster is off', async () => {
    configure();
    bot.embedPoster = false;
    const pending = await seedPending();
    const request = await getRepository(MediaRequest).findOneOrFail({
      where: { id: pending.id },
      relations: { requestedBy: true, media: true },
    });
    await new DiscordBotAgent().send(
      Notification.MEDIA_PENDING,
      payloadFor(request, request.media)
    );
    const [embed] = rest.calls[0].body?.embeds as { thumbnail?: object }[];
    assert.equal(embed.thumbnail, undefined);
  });

  it('isn’t used when off or without a channel, and posts nothing else', async () => {
    configure(TOKEN, false);
    assert.equal(new DiscordBotAgent().shouldSend(), false);
    configure();
    bot.options.channelId = '';
    assert.equal(new DiscordBotAgent().shouldSend(), false);

    configure();
    const pending = await seedPending();
    const request = await getRepository(MediaRequest).findOneOrFail({
      where: { id: pending.id },
      relations: { requestedBy: true, media: true },
    });
    const agent = new DiscordBotAgent();
    await agent.send(
      Notification.MEDIA_AVAILABLE,
      payloadFor(request, request.media)
    );
    await agent.send(Notification.ISSUE_CREATED, {
      ...payloadFor(request, request.media),
      request: undefined,
    });
    await agent.send(Notification.MEDIA_PENDING, {
      ...payloadFor(request, request.media),
      notifySystem: false,
    });
    assert.equal(rest.calls.length, 0);
  });

  it('takes the buttons off once the request is approved elsewhere', async () => {
    configure();
    // As the app has it: a signed-in account, loaded.
    const admin = await getRepository(User).findOneOrFail({
      where: {
        id: (await makeUser('glasswing', Permission.MANAGE_REQUESTS)).id,
      },
    });
    const pending = await seedPending();
    await getRepository(DiscordApprovalMessage).save(
      new DiscordApprovalMessage({
        requestId: pending.id,
        channelId: CHANNEL,
        messageId: '400000000000000004',
      })
    );
    answer = (call) =>
      call.method === 'GET' && call.path.includes('/messages/')
        ? {
            body: {
              id: '400000000000000004',
              embeds: [EMBED],
              components: [{}],
            },
          }
        : undefined;

    const change = await changeRequestStatus(pending.id, 'approve', admin);
    assert.equal(change.outcome, 'done');
    const request = change.outcome === 'done' ? change.request : pending;
    await new DiscordBotAgent().send(
      Notification.MEDIA_APPROVED,
      payloadFor(request, request.media)
    );

    const path = `/channels/${CHANNEL}/messages/400000000000000004`;
    assert.deepEqual(
      rest.calls.map((call) => `${call.method} ${call.path}`),
      [`GET ${path}`, `PATCH ${path}`]
    );
    const patch = rest.calls[1].body!;
    assert.deepEqual(patch.components, []);
    assert.equal(
      (patch.embeds as { fields: { value: string }[] }[])[0].fields[1].value,
      'Approved by glasswing'
    );
    assert.equal(await getRepository(DiscordApprovalMessage).count(), 0);

    // Only once.
    await new DiscordBotAgent().send(
      Notification.MEDIA_APPROVED,
      payloadFor(request, request.media)
    );
    assert.equal(rest.calls.length, 2);
  });

  it('settles and lets go of messages left over a day after their request was', async () => {
    configure();
    const admin = await getRepository(User).findOneOrFail({
      where: {
        id: (await makeUser('glasswing', Permission.MANAGE_REQUESTS)).id,
      },
    });
    const pending = await seedPending();
    const settled = await seedPending(8403);
    // Settled while the bot was off: its message wasn't touched.
    bot.enabled = false;
    await changeRequestStatus(settled.id, 'decline', admin);
    bot.enabled = true;
    const repo = getRepository(DiscordApprovalMessage);
    const [, old] = await repo.save([
      new DiscordApprovalMessage({
        requestId: pending.id,
        channelId: CHANNEL,
        messageId: '400000000000000031',
      }),
      new DiscordApprovalMessage({
        requestId: settled.id,
        channelId: CHANNEL,
        messageId: '400000000000000032',
      }),
    ]);
    const now = Date.now();
    await repo.update(old.id, { createdAt: new Date(now - 2 * 86_400_000) });
    answer = (call) =>
      call.method === 'GET' ? { body: { embeds: [EMBED] } } : undefined;

    assert.equal(await discordBot.prune(now), 1);
    const path = `/channels/${CHANNEL}/messages/400000000000000032`;
    assert.deepEqual(
      rest.calls.map((call) => `${call.method} ${call.path}`),
      [`GET ${path}`, `PATCH ${path}`]
    );
    assert.equal(
      (rest.calls[1].body?.embeds as { fields: { value: string }[] }[])[0]
        .fields[1].value,
      'Declined by glasswing'
    );
    assert.deepEqual(
      (await repo.find()).map((row) => row.messageId),
      ['400000000000000031']
    );
  });

  it('forgets every kept message for a new bot', async () => {
    const pending = await seedPending();
    await getRepository(DiscordApprovalMessage).save(
      new DiscordApprovalMessage({
        requestId: pending.id,
        channelId: CHANNEL,
        messageId: '400000000000000041',
      })
    );
    await discordBot.forgetMessages();
    assert.equal(await getRepository(DiscordApprovalMessage).count(), 0);
  });
});
