import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { initI18n } from '@server/i18n';
import { Notification } from '@server/lib/notifications';
import TelegramAgent from '@server/lib/notifications/agents/telegram';
import notificationHttp from '@server/lib/notifications/http';
import type { CallbackQuery } from '@server/lib/notifications/telegramButtons';
import telegramButtons from '@server/lib/notifications/telegramButtons';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { setupTestDb } from '@server/test/db';
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
 * Approve and Decline on Telegram: the buttons on the message, a press read
 * from getUpdates, and the poll that reads them. Telegram itself is stubbed:
 * every call to it goes through notificationHttp.post.
 */

setupTestDb();

mock.method(MediaRequest, 'sendNotification', async () => true);

Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  configurable: true,
  set() {},
  get() {
    return async () => ({
      id: 1,
      title: 'Lantern Song',
      release_date: '2020-01-01',
    });
  },
});

interface Sent {
  method: string;
  body: Record<string, unknown>;
}

let sent: Sent[] = [];
/** How Telegram answers getUpdates, one call at a time. */
let polls: ((signal: AbortSignal) => Promise<unknown>)[] = [];
/** What Telegram kept from before a run started (its offset -1 call). */
let backlog: unknown[] = [];

const hangUntilAborted = (signal: AbortSignal) =>
  new Promise((_, reject) =>
    signal.addEventListener('abort', () => reject(new Error('canceled')))
  );

const post = mock.method(
  notificationHttp,
  'post',
  async (
    url: string,
    body: Record<string, unknown>,
    config?: { signal: AbortSignal }
  ) => {
    const method = url.split('/').pop()!;
    if (method === 'getUpdates' && body.offset === -1) {
      sent.push({ method: 'skipBacklog', body });
      return { data: { ok: true, result: backlog } };
    }
    sent.push({ method, body });
    if (method === 'getUpdates') {
      const next = polls.shift() ?? hangUntilAborted;
      return { data: { ok: true, result: await next(config!.signal) } };
    }
    return { data: { ok: true, result: true } };
  }
);

const telegram = getSettings().notifications.agents.telegram;
const saved = {
  telegram: structuredClone(telegram),
  waits: { ...telegramButtons.waits },
};

before(() => {
  initI18n();
});

beforeEach(() => {
  sent = [];
  polls = [];
  backlog = [];
  post.mock.resetCalls();
});

afterEach(async () => {
  await telegramButtons.stop();
  Object.assign(telegram, structuredClone(saved.telegram));
  Object.assign(telegramButtons.waits, saved.waits);
});

after(async () => {
  await telegramButtons.stop();
});

const until = async (condition: () => boolean, what: string) => {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > 5000) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const sentOf = (method: string) => sent.filter((s) => s.method === method);

const makeUser = (name: string, permissions: number, telegramChatId?: string) =>
  getRepository(User).save(
    new User({
      email: `${name}@test.local`,
      plexUsername: name,
      permissions,
      avatar: '',
      settings: new UserSettings({ telegramChatId }),
    })
  );

const seedPending = async (tmdbId = 8301) => {
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

const ORIGINAL =
  'New Movie Request - Harbour Lights (2020)\n\nRequested By: someone';

const pressOf = (
  fromId: number,
  data: string,
  message: Partial<CallbackQuery['message']> = {}
): CallbackQuery => ({
  id: `press-${fromId}-${data}`,
  from: { id: fromId, first_name: 'Someone' },
  data,
  message: {
    message_id: 77,
    chat: { id: -1001 },
    text: ORIGINAL,
    entities: [{ type: 'bold', offset: 0, length: 40 }],
    ...message,
  },
});

describe('a Telegram button press', () => {
  it('approves as the account linked to whoever pressed, and says so on the message', async () => {
    const admin = await makeUser(
      'glasswing',
      Permission.MANAGE_REQUESTS,
      '5551'
    );
    const pending = await seedPending();

    await telegramButtons.handle(
      'bot-token',
      pressOf(5551, `sai:approve:${pending.id}`)
    );

    const saved = await stored(pending.id);
    assert.equal(saved.status, MediaRequestStatus.APPROVED);
    assert.equal(saved.modifiedBy?.id, admin.id);

    const [answer] = sentOf('answerCallbackQuery');
    assert.equal(
      answer.body.callback_query_id,
      `press-5551-sai:approve:${pending.id}`
    );
    assert.equal(answer.body.text, 'Approved by glasswing');

    const [edit] = sentOf('editMessageText');
    assert.equal(edit.body.chat_id, -1001);
    assert.equal(edit.body.message_id, 77);
    assert.equal(edit.body.text, `${ORIGINAL}\n\nApproved by glasswing`);
    assert.deepEqual(edit.body.entities, [
      { type: 'bold', offset: 0, length: 40 },
      {
        type: 'italic',
        offset: ORIGINAL.length + 2,
        length: 'Approved by glasswing'.length,
      },
    ]);
    assert.deepEqual(edit.body.reply_markup, { inline_keyboard: [] });
  });

  it('declines, and edits a poster’s caption the same way', async () => {
    await makeUser('garden', Permission.ADMIN, '5552');
    const pending = await seedPending();

    await telegramButtons.handle(
      'bot-token',
      pressOf(5552, `sai:decline:${pending.id}`, {
        text: undefined,
        entities: undefined,
        caption: 'Poster caption',
      })
    );

    assert.equal(
      (await stored(pending.id)).status,
      MediaRequestStatus.DECLINED
    );
    const [edit] = sentOf('editMessageCaption');
    assert.equal(edit.body.caption, 'Poster caption\n\nDeclined by garden');
    assert.deepEqual(edit.body.reply_markup, { inline_keyboard: [] });
  });

  it('does nothing for someone not linked to an account, and tells them why', async () => {
    const pending = await seedPending();

    await telegramButtons.handle(
      'bot-token',
      pressOf(9999, `sai:approve:${pending.id}`)
    );

    assert.equal((await stored(pending.id)).status, MediaRequestStatus.PENDING);
    const [answer] = sentOf('answerCallbackQuery');
    assert.match(String(answer.body.text), /can’t approve requests here/);
    assert.equal(answer.body.show_alert, true);
    assert.equal(sentOf('editMessageText').length, 0);
  });

  it('does nothing for someone linked to an account that may not manage requests', async () => {
    await makeUser('requester', Permission.REQUEST, '5553');
    const pending = await seedPending();

    await telegramButtons.handle(
      'bot-token',
      pressOf(5553, `sai:approve:${pending.id}`)
    );

    assert.equal((await stored(pending.id)).status, MediaRequestStatus.PENDING);
    assert.match(
      String(sentOf('answerCallbackQuery')[0].body.text),
      /can’t approve requests here/
    );
  });

  it('acts for nobody when two accounts that manage requests claim the same Telegram user', async () => {
    await makeUser('one', Permission.MANAGE_REQUESTS, '5554');
    await makeUser('two', Permission.MANAGE_REQUESTS, '5554');
    const pending = await seedPending();

    await telegramButtons.handle(
      'bot-token',
      pressOf(5554, `sai:approve:${pending.id}`)
    );

    assert.equal((await stored(pending.id)).status, MediaRequestStatus.PENDING);
    const [answer] = sentOf('answerCallbackQuery');
    assert.match(String(answer.body.text), /linked to more than one/);
    assert.equal(answer.body.show_alert, true);
  });

  it('says a request already handled was, and takes the buttons away', async () => {
    await makeUser('static', Permission.MANAGE_REQUESTS, '5555');
    const pending = await seedPending();
    await getRepository(MediaRequest).update(pending.id, {
      status: MediaRequestStatus.DECLINED,
    });

    await telegramButtons.handle(
      'bot-token',
      pressOf(5555, `sai:approve:${pending.id}`)
    );

    assert.equal(
      (await stored(pending.id)).status,
      MediaRequestStatus.DECLINED
    );
    assert.equal(
      sentOf('answerCallbackQuery')[0].body.text,
      'Already declined'
    );
    assert.equal(
      sentOf('editMessageText')[0].body.text,
      `${ORIGINAL}\n\nAlready declined`
    );
  });

  it('only answers a press it doesn’t recognise', async () => {
    const pending = await seedPending();

    await telegramButtons.handle(
      'bot-token',
      pressOf(5551, `sai:delete:${pending.id}`)
    );

    assert.deepEqual(
      sent.map((s) => s.method),
      ['answerCallbackQuery']
    );
    assert.equal(sent[0].body.text, undefined);
  });
});

describe('Telegram’s Approve and Decline buttons on messages', () => {
  const keyboardOf = (type: Notification, approvalButtons: boolean, id = 12) =>
    new TelegramAgent({
      ...structuredClone(telegram),
      enabled: true,
      options: { ...telegram.options, approvalButtons },
    })['approvalKeyboard'](type, {
      subject: 'Harbour Lights',
      notifySystem: true,
      notifyAdmin: true,
      request: { id } as MediaRequest,
    });

  it('are on requests waiting for approval when turned on', () => {
    assert.deepEqual(keyboardOf(Notification.MEDIA_PENDING, true), {
      inline_keyboard: [
        [
          { text: 'Approve', callback_data: 'sai:approve:12' },
          { text: 'Decline', callback_data: 'sai:decline:12' },
        ],
      ],
    });
  });

  it('are left off when turned off, and on anything else', () => {
    assert.equal(keyboardOf(Notification.MEDIA_PENDING, false), undefined);
    assert.equal(keyboardOf(Notification.MEDIA_APPROVED, true), undefined);
  });
});

describe('listening for presses', () => {
  const turnOn = (token = 'bot-token') => {
    telegram.enabled = true;
    telegram.options.botAPI = token;
    telegram.options.approvalButtons = true;
  };

  it('starts and stops with the settings', async () => {
    telegram.enabled = true;
    telegram.options.botAPI = 'bot-token';
    telegram.options.approvalButtons = false;
    telegramButtons.refresh();
    assert.equal(telegramButtons.polling, false, 'buttons off');

    telegram.options.approvalButtons = true;
    telegram.options.botAPI = '';
    telegramButtons.refresh();
    assert.equal(telegramButtons.polling, false, 'no token');

    turnOn();
    telegram.enabled = false;
    telegramButtons.refresh();
    assert.equal(telegramButtons.polling, false, 'agent off');

    turnOn();
    telegramButtons.refresh();
    assert.equal(telegramButtons.polling, true);
    await until(() => sentOf('getUpdates').length === 1, 'the first poll');
    const [first] = sentOf('getUpdates');
    assert.deepEqual(first.body.allowed_updates, ['callback_query']);
    assert.equal(first.body.timeout, 30);

    // Saving again unchanged leaves the poll alone.
    telegramButtons.refresh();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sentOf('getUpdates').length, 1);

    telegram.options.approvalButtons = false;
    telegramButtons.refresh();
    assert.equal(telegramButtons.polling, false);
  });

  it('starts again with a new bot token', async () => {
    turnOn('first-token');
    telegramButtons.refresh();
    await until(() => sentOf('getUpdates').length === 1, 'the first poll');

    telegram.options.botAPI = 'second-token';
    telegramButtons.refresh();
    await until(
      () => sentOf('getUpdates').length === 2,
      'a poll with the new token'
    );

    const urls = post.mock.calls
      .filter(
        (call) => (call.arguments[1] as { offset?: number }).offset !== -1
      )
      .map((call) => call.arguments[0] as string);
    assert.ok(urls[0].includes('/botfirst-token/getUpdates'));
    assert.ok(urls[1].includes('/botsecond-token/getUpdates'));
  });

  it('handles the presses it reads, and asks only for newer ones after', async () => {
    await makeUser('glasswing', Permission.MANAGE_REQUESTS, '5551');
    const pending = await seedPending();
    polls.push(async () => [
      {
        update_id: 500,
        callback_query: pressOf(5551, `sai:approve:${pending.id}`),
      },
    ]);

    turnOn();
    telegramButtons.refresh();
    await until(() => sentOf('getUpdates').length === 2, 'the next poll');

    assert.equal(
      (await stored(pending.id)).status,
      MediaRequestStatus.APPROVED
    );
    assert.equal(sentOf('getUpdates')[1].body.offset, 501);
  });

  it('waits, longer each time, while another program polls the bot, and says so once', async (t) => {
    const warn = t.mock.method(logger, 'warn');
    const conflict = async () => {
      throw Object.assign(new Error('Request failed with status code 409'), {
        response: {
          status: 409,
          data: {
            ok: false,
            description:
              'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running',
          },
        },
      });
    };
    polls.push(conflict, conflict, conflict, async () => []);
    Object.assign(telegramButtons.waits, {
      retryMs: 1,
      conflictMs: 10,
      tokenMs: 1,
      longestMs: 25,
    });
    const waited: number[] = [];
    const realWait = telegramButtons['wait'].bind(telegramButtons);
    t.mock.method(
      telegramButtons,
      'wait' as never,
      ((ms: number, signal: AbortSignal) => {
        waited.push(ms);
        return realWait(ms, signal);
      }) as never
    );

    turnOn();
    telegramButtons.refresh();
    await until(
      () => sentOf('getUpdates').length === 5,
      'polling after the conflict'
    );

    assert.deepEqual(waited, [10, 20, 25]);
    const said = warn.mock.calls.filter((call) =>
      String(call.arguments[0]).includes('another program is polling')
    );
    assert.equal(said.length, 1, 'said once, not on every try');
    assert.equal(telegramButtons.polling, true, 'still running');
  });

  it('drops presses kept from before it started, rather than acting on them late', async () => {
    await makeUser('glasswing', Permission.MANAGE_REQUESTS, '5551');
    const pending = await seedPending();
    backlog = [
      {
        update_id: 900,
        callback_query: pressOf(5551, `sai:approve:${pending.id}`),
      },
    ];

    turnOn();
    telegramButtons.refresh();
    await until(() => sentOf('getUpdates').length === 1, 'the first poll');

    const [skip] = sentOf('skipBacklog');
    assert.equal(skip.body.timeout, 0);
    assert.equal(sentOf('getUpdates')[0].body.offset, 901);
    assert.equal(sentOf('answerCallbackQuery').length, 0);
    assert.equal((await stored(pending.id)).status, MediaRequestStatus.PENDING);
  });

  it('starts the next run only once the last has stopped, which leaves the rest of its batch', async (t) => {
    let release!: () => void;
    const handled: string[] = [];
    t.mock.method(telegramButtons, 'handle', async (token: string) => {
      handled.push(token);
      await new Promise<void>((resolve) => (release = resolve));
    });
    polls.push(async () => [
      { update_id: 10, callback_query: pressOf(5551, 'sai:approve:1') },
      { update_id: 11, callback_query: pressOf(5551, 'sai:approve:2') },
    ]);

    turnOn('first-token');
    telegramButtons.refresh();
    await until(() => handled.length === 1, 'the first press');

    telegram.options.botAPI = 'second-token';
    telegramButtons.refresh();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sentOf('skipBacklog').length, 1, 'the new run waits');

    release();
    await until(() => sentOf('skipBacklog').length === 2, 'the new run');

    assert.deepEqual(
      handled,
      ['first-token'],
      'the stopped run went no further'
    );
    const calls = post.mock.calls.map((call) => ({
      url: call.arguments[0] as string,
      body: call.arguments[1] as { offset?: number },
    }));
    const newRun = calls.filter((call) => call.url.includes('second-token'));
    // Its own fresh start, not the old bot's place in the queue.
    assert.equal(newRun[0].body.offset, -1);
  });
});
