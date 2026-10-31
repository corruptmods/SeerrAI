import { MusicBrainz } from '@server/api/musicbrainz';
import TautulliAPI from '@server/api/tautulli';
import TheMovieDb from '@server/api/themoviedb';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import type AgentRun from '@server/entity/AgentRun';
import AiUsage from '@server/entity/AiUsage';
import { MediaList, MediaListMember } from '@server/entity/MediaList';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import agent from '@server/lib/agent';
import { clearAiCache, today } from '@server/lib/ai';
import { creditReport, forgetSpendReports } from '@server/lib/ai/credit';
import { redact } from '@server/lib/ai/features';
import { resetProviderMemoryForTests } from '@server/lib/ai/providers';
import ImageProxy from '@server/lib/imageproxy';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import aiRoutes from '@server/routes/ai';
import aiSettingsRoutes from '@server/routes/settings/ai';
import { setupTestDb } from '@server/test/db';
import axios, { AxiosError, AxiosHeaders } from 'axios';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import http from 'node:http';
import path from 'node:path';
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import sharp from 'sharp';

/*
 * The AI features through the real API spec, with the model stubbed at the
 * HTTP call: what each person may use, what it costs them, and what is (and
 * is not) sent to the model.
 */

setupTestDb();

// ---- a fake model -----------------------------------------------------------

/** What each call sent, and what the model answers next. */
let calls: { system: string; prompt: string; image?: unknown }[] = [];
let answers: (string | Error)[] = [];

const modelReply = (text: string) => ({
  data: {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 10, output_tokens: 5 },
  },
});

mock.method(
  axios,
  'post',
  async (
    _url: string,
    body: {
      system: string;
      messages: {
        content: string | { type: string; text?: string; source?: unknown }[];
      }[];
    }
  ) => {
    const content = body.messages[0].content;
    calls.push({
      system: body.system,
      prompt:
        typeof content === 'string'
          ? content
          : (content.find((part) => part.type === 'text')?.text ?? ''),
      image:
        typeof content === 'string'
          ? undefined
          : content.find((part) => part.type === 'image')?.source,
    });
    const next = answers.shift() ?? '{}';
    if (next instanceof Error) {
      throw next;
    }
    return modelReply(next);
  }
);

// ---- a fake TMDB ------------------------------------------------------------

const stub = (name: string, fn: (...args: never[]) => unknown) =>
  Object.defineProperty(TheMovieDb.prototype, name, {
    configurable: true,
    set() {},
    get() {
      return fn;
    },
  });

stub('searchMovies', async ({ query }: { query: string }) => ({
  page: 1,
  total_pages: 1,
  total_results: 1,
  results:
    query === 'Hedgehog Morning'
      ? [
          {
            id: 137,
            title: 'Hedgehog Morning',
            release_date: '1993-02-11',
            media_type: 'movie',
            genre_ids: [],
            overview: '',
            popularity: 1,
            vote_average: 8,
            vote_count: 1,
            adult: false,
            original_language: 'en',
            original_title: 'Hedgehog Morning',
            video: false,
          },
        ]
      : [],
}));
stub('searchTvShows', async () => ({
  page: 1,
  total_pages: 1,
  total_results: 0,
  results: [],
}));
stub('getTvShow', async () => ({
  id: 500,
  name: 'The Show',
  seasons: [
    { season_number: 1, overview: 'Season one happens.' },
    { season_number: 2, overview: 'Season two happens.' },
    { season_number: 3, overview: 'SECRET FUTURE SEASON.' },
  ],
}));
stub('getTvSeason', async ({ seasonNumber }: { seasonNumber: number }) => ({
  episodes: [1, 2, 3, 4].map((n) => ({
    episode_number: n,
    name: `Ep ${n}`,
    overview: `Season ${seasonNumber} episode ${n} events.`,
  })),
}));

// ---- the app ----------------------------------------------------------------

let server: Server;
let port: number;
let actingAs: User;
let admin: User;
let member: User;

const call = <T>(method: string, route: string, body?: unknown) =>
  new Promise<{ status: number; body: T }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: route,
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
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: raw ? JSON.parse(raw) : (undefined as T),
            });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });

const makeUser = async (name: string, permissions: number) =>
  getRepository(User).save(
    new User({
      email: `${name}@test.local`,
      plexUsername: name,
      permissions,
      avatar: '',
    })
  );

const setUp = (over: Partial<ReturnType<typeof getSettings>['ai']> = {}) => {
  getSettings().ai = {
    enabled: true,
    provider: 'anthropic',
    apiKey: 'saved-secret-key',
    baseUrl: '',
    model: 'claude-test',
    featureModels: {},
    dailyLimit: 0,
    ...over,
  };
};

beforeEach(async () => {
  calls = [];
  answers = [];
  clearAiCache();
  getSettings().aiCredit = {
    adminKey: '',
    balance: null,
    balanceAt: null,
    prices: {},
    outOfCreditAt: null,
  };
  forgetSpendReports();
  resetProviderMemoryForTests();
  getSettings().main.disabledFeatures = [];
  setUp();
  admin = await makeUser('ai-admin', Permission.ADMIN);
  member = await makeUser('ai-member', Permission.REQUEST);
  actingAs = member;

  if (!server) {
    const app = express();
    app.use(express.json());
    app.use(
      OpenApiValidator.middleware({
        apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
        validateRequests: true,
        validateSecurity: false,
      })
    );
    app.use((req, _res, next) => {
      (req as unknown as { user: User }).user = actingAs;
      next();
    });
    app.use('/api/v1/ai', aiRoutes);
    app.use('/api/v1/settings/ai', aiSettingsRoutes);
    app.use(
      (
        err: { status?: number; message: string },
        _req: express.Request,
        res: express.Response,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _next: express.NextFunction
      ) => res.status(err.status ?? 500).json({ message: err.message })
    );
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    port = (server.address() as { port: number }).port;
  }
});

after(() => {
  server?.close();
});

const httpError = (status: number) =>
  new AxiosError('failed', 'ERR_BAD_REQUEST', undefined, undefined, {
    status,
    data: {},
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
  });

// ---- the tests ----------------------------------------------------------------

describe('AI settings', () => {
  const form = {
    enabled: true,
    provider: 'anthropic',
    apiKey: '',
    baseUrl: '',
    model: 'claude-test',
    featureModels: {},
    dailyLimit: 20,
  };

  it('never sends the key back', async () => {
    actingAs = admin;
    const { status, body } = await call<{ apiKey: string; hasApiKey: boolean }>(
      'GET',
      '/api/v1/settings/ai'
    );
    assert.equal(status, 200);
    assert.equal(body.apiKey, '');
    assert.equal(body.hasApiKey, true);
    assert.ok(!JSON.stringify(body).includes('saved-secret-key'));
  });

  it('keeps the saved key when the field is left empty', async () => {
    actingAs = admin;
    const { status } = await call('POST', '/api/v1/settings/ai', {
      ...form,
      dailyLimit: 5,
    });
    assert.equal(status, 200);
    assert.equal(getSettings().ai.apiKey, 'saved-secret-key');
    assert.equal(getSettings().ai.dailyLimit, 5);
  });

  it('refuses to save a connection that does not work, changing nothing', async () => {
    actingAs = admin;
    answers = [httpError(401)];
    const { status, body } = await call<{ message: string }>(
      'POST',
      '/api/v1/settings/ai',
      { ...form, apiKey: 'wrong-key' }
    );
    assert.equal(status, 400);
    assert.match(body.message, /rejected the API key/);
    assert.equal(getSettings().ai.apiKey, 'saved-secret-key');
  });

  it('tests a changed model before saving it', async () => {
    actingAs = admin;
    answers = ['OK'];
    const { status } = await call('POST', '/api/v1/settings/ai', {
      ...form,
      model: 'claude-other',
    });
    assert.equal(status, 200);
    assert.equal(calls.length, 1, 'one tiny test request');
    assert.equal(getSettings().ai.model, 'claude-other');
  });
});

describe('the saved key', () => {
  it('is never sent to a different provider or address', async () => {
    actingAs = admin;
    const seen: Record<string, string>[] = [];
    const get = mock.method(
      axios,
      'get',
      async (_url: string, config: never) => {
        seen.push((config as { headers: Record<string, string> }).headers);
        return { data: { data: [] } };
      }
    );
    try {
      const form = {
        enabled: true,
        provider: 'openai',
        apiKey: '',
        model: '',
        featureModels: {},
        dailyLimit: 0,
      };
      const local = await call('POST', '/api/v1/settings/ai/models', {
        ...form,
        baseUrl: 'http://elsewhere.test/v1',
      });
      assert.equal(local.status, 200);
      assert.equal(seen[0].authorization, undefined);
      assert.ok(!JSON.stringify(seen).includes('saved-secret-key'));

      // OpenAI itself needs a key, and the saved Claude key is not it.
      const openai = await call<{ message: string }>(
        'POST',
        '/api/v1/settings/ai/models',
        { ...form, baseUrl: '' }
      );
      assert.equal(openai.status, 400);
      assert.match(openai.body.message, /Enter the API key/);
      assert.equal(seen.length, 1);
    } finally {
      get.mock.restore();
    }
  });
});

describe('who gets the AI features', () => {
  it('everyone, once an admin has set it up', async () => {
    const { body } = await call<{ features: Record<string, boolean> }>(
      'GET',
      '/api/v1/ai/status'
    );
    assert.equal(body.features.aiChat, true);
  });

  it('nobody while it is not set up', async () => {
    setUp({ enabled: false });
    const { body } = await call<{ features: Record<string, boolean> }>(
      'GET',
      '/api/v1/ai/status'
    );
    assert.ok(Object.values(body.features).every((on) => !on));
    const chat = await call<{ message: string; code: string }>(
      'POST',
      '/api/v1/ai/chat',
      { message: 'hi' }
    );
    assert.equal(chat.status, 403);
    // A code for the page to show in the person's language, and the English.
    assert.equal(chat.body.code, 'off');
    assert.match(chat.body.message, /turned off/);
    assert.equal(calls.length, 0);
  });

  it('not someone who turned it off for themselves', async () => {
    member.settings = new UserSettings({
      user: member,
      disabledFeatures: ['aiChat'],
    });
    await getRepository(User).save(member);
    actingAs = await getRepository(User).findOneOrFail({
      where: { id: member.id },
      relations: { settings: true },
    });
    const { status } = await call('POST', '/api/v1/ai/chat', { message: 'hi' });
    assert.equal(status, 403);
    assert.equal(calls.length, 0);
  });

  it('keeps admin tools to admins', async () => {
    for (const [method, route, body] of [
      ['POST', '/api/v1/ai/deletion-review', undefined],
      ['GET', '/api/v1/ai/issue/1', undefined],
      ['POST', '/api/v1/ai/explain-log', { message: 'x' }],
    ] as const) {
      assert.equal((await call(method, route, body)).status, 403, route);
    }
    assert.equal(calls.length, 0);
  });
});

describe('the AI chat', () => {
  it('turns a description into real titles with their status', async () => {
    answers = [
      '```json\n{"r":"Sounds like this one.","titles":[{"t":"Hedgehog Morning","y":1993,"k":"movie"},{"t":"Made Up Film","y":2001,"k":"movie"}]}\n```',
    ];
    const { status, body } = await call<{
      reply: string;
      results: { id: number; title: string; mediaType: string }[];
    }>('POST', '/api/v1/ai/chat', {
      message: 'the movie where the guy relives the same day',
    });
    assert.equal(status, 200);
    assert.equal(body.reply, 'Sounds like this one.');
    // A title TMDB cannot find is dropped, not guessed.
    assert.deepEqual(
      body.results.map((r) => r.id),
      [137]
    );
  });

  describe('with a photo', () => {
    const make = (format: 'jpeg' | 'png', colour: string) =>
      sharp({
        create: { width: 64, height: 48, channels: 3, background: colour },
      })
        [format]()
        .toBuffer()
        .then((buffer) => buffer.toString('base64'));
    let jpeg: string;
    let png: string;
    before(async () => {
      jpeg = await make('jpeg', '#c03030');
      png = await make('png', '#3030c0');
    });

    it('finds the titles in a picture sent on its own', async () => {
      answers = [
        '{"r":"That poster is Hedgehog Morning.","titles":[{"t":"Hedgehog Morning","y":1993,"k":"movie"}]}',
      ];
      const { status, body } = await call<{
        reply: string;
        results: { id: number }[];
      }>('POST', '/api/v1/ai/chat', {
        message: '',
        image: { type: 'image/jpeg', data: jpeg },
      });
      assert.equal(status, 200, JSON.stringify(body));
      assert.deepEqual(
        body.results.map((r) => r.id),
        [137]
      );
      // What the model gets is the photo made over to its budget.
      const sent = calls[0].image as { media_type: string; data: string };
      assert.equal(sent.media_type, 'image/jpeg');
      assert.equal(
        (await sharp(Buffer.from(sent.data, 'base64')).metadata()).width,
        64
      );
      assert.match(calls[0].system, /A picture is attached/);
      assert.match(calls[0].prompt, /only the picture/);
    });

    it('tells the model about pictures only when one is sent', async () => {
      answers = ['{"r":"","titles":[]}'];
      await call('POST', '/api/v1/ai/chat', { message: 'same day' });
      assert.doesNotMatch(calls[0].system, /picture/i);
      assert.equal(calls[0].image, undefined);
    });

    it('asks again for a different picture with the same words', async () => {
      answers = ['{"r":"","titles":[]}', '{"r":"","titles":[]}'];
      await call('POST', '/api/v1/ai/chat', {
        message: 'what is this',
        image: { type: 'image/jpeg', data: jpeg },
      });
      await call('POST', '/api/v1/ai/chat', {
        message: 'what is this',
        image: { type: 'image/png', data: png },
      });
      assert.equal(calls.length, 2);
    });

    it('refuses a picture that is not what it says, and an empty ask', async () => {
      const wrong = await call<{ message: string }>('POST', '/api/v1/ai/chat', {
        message: 'this',
        image: { type: 'image/jpeg', data: png },
      });
      assert.equal(wrong.status, 400);
      assert.match(wrong.body.message, /could not be read/);
      const empty = await call('POST', '/api/v1/ai/chat', { message: ' ' });
      assert.equal(empty.status, 400);
      assert.equal(calls.length, 0, 'the model is never asked');
    });
  });

  it('answers the same question again from memory, at no cost', async () => {
    getSettings().ai.dailyLimit = 1;
    answers = ['{"r":"","titles":[{"t":"Hedgehog Morning","k":"movie"}]}'];
    const first = await call('POST', '/api/v1/ai/chat', {
      message: 'same day',
    });
    const again = await call('POST', '/api/v1/ai/chat', {
      message: 'same day',
    });
    assert.equal(first.status, 200);
    assert.equal(again.status, 200);
    assert.equal(calls.length, 1);
  });

  it('asks once more when the answer is not readable, then gives up', async () => {
    answers = ['I think Hedgehog Morning', '{"r":"ok","titles":[]}'];
    const ok = await call('POST', '/api/v1/ai/chat', { message: 'one' });
    assert.equal(ok.status, 200);
    assert.equal(calls.length, 2);

    answers = ['nope', 'still nope'];
    const bad = await call<{ message: string }>('POST', '/api/v1/ai/chat', {
      message: 'two',
    });
    assert.equal(bad.status, 502);
    assert.match(bad.body.message, /did not answer in a form/);
  });

  it('knows what it said, and never shows an offered title again', async () => {
    answers = [
      '{"r":"More like that:","titles":[{"t":"Hedgehog Morning","y":1993,"k":"movie"}]}',
    ];
    const { status, body } = await call<{
      reply: string;
      results: unknown[];
    }>('POST', '/api/v1/ai/chat', {
      message: 'yes',
      turns: [
        {
          ask: 'a film about a repeating day',
          reply: 'Want more like these?',
          offered: ['Hedgehog Morning (1993)'],
        },
      ],
    });
    assert.equal(status, 200);
    assert.match(calls[0].prompt, /You: Want more like these\?/);
    assert.match(calls[0].prompt, /Already offered: Hedgehog Morning \(1993\)/);
    // The model repeated itself; the person does not see it, or a "more
    // like that" with nothing under it.
    assert.deepEqual(body.results, []);
    assert.match(body.reply, /Nothing new turned up/);
  });

  it('clips an earlier turn that runs long rather than refusing the message', async () => {
    // The app marks a turn that came with a photo, which can take a full
    // 500-character message over the limit.
    answers = ['{"r":"ok","titles":[]}'];
    const { status } = await call('POST', '/api/v1/ai/chat', {
      message: 'and another',
      turns: [
        {
          ask: `(sent a photo) ${'a'.repeat(500)}`,
          offered: ['x'.repeat(250)],
        },
      ],
    });
    assert.equal(status, 200);
    assert.equal(calls.length, 1);
  });

  it('sets up requesting what it offered, and leaves the rest to the person', async () => {
    answers = [
      '{"r":"I can request those for you.","titles":[],"do":"request"}',
    ];
    const { status, body } = await call<{
      reply: string;
      results: unknown[];
      action?: { do: string; earlier: boolean };
    }>('POST', '/api/v1/ai/chat', {
      message: 'request all of those',
      turns: [{ ask: 'films', offered: ['Hedgehog Morning (1993)'] }],
    });
    assert.equal(status, 200);
    assert.deepEqual(body.action, { do: 'request', earlier: true });
    assert.deepEqual(body.results, []);
  });

  it('names a new list, and may list a title it offered before', async () => {
    answers = [
      '{"r":"Here is a list.","titles":[{"t":"Hedgehog Morning","y":1993,"k":"movie"}],"do":"list","n":"Time loops"}',
    ];
    const { body } = await call<{
      results: { id: number }[];
      action?: { do: string; name?: string; earlier: boolean };
    }>('POST', '/api/v1/ai/chat', {
      message: 'make me a list of time loop films',
      turns: [{ ask: 'films', offered: ['Hedgehog Morning (1993)'] }],
    });
    assert.deepEqual(body.action, {
      do: 'list',
      name: 'Time loops',
      earlier: false,
    });
    assert.deepEqual(
      body.results.map((r) => r.id),
      [137]
    );
  });

  it('hands an admin’s change to the admin agent, to propose for approval', async () => {
    const asked: string[] = [];
    const ask = mock.method(agent, 'ask', async (text: string) => {
      asked.push(text);
      return { id: 42 } as AgentRun;
    });
    actingAs = admin;
    answers = [
      '{"r":"The admin agent is on it; nothing changes until you approve.","titles":[{"t":"Hedgehog Morning","y":1993,"k":"movie"}],"do":"admin"}',
    ];
    const { status, body } = await call<{
      reply: string;
      results: unknown[];
      fix?: { kind: string; ok: boolean; link?: string };
    }>('POST', '/api/v1/ai/chat', {
      message: 'the copy of this one is bad, delete it and block the group',
    });
    assert.equal(status, 200);
    assert.match(calls[0].system, /They are an admin\./);
    assert.deepEqual(body.fix, {
      kind: 'agent',
      ok: true,
      link: '/backfill/agent/42',
    });
    assert.deepEqual(body.results, []);
    assert.deepEqual(asked, [
      'the copy of this one is bad, delete it and block the group (The title: Hedgehog Morning (1993), a movie.)',
    ]);
    ask.mock.restore();
  });

  it('never offers the admin agent to someone who is not an admin', async () => {
    const ask = mock.method(agent, 'ask', async () => ({ id: 1 }) as AgentRun);
    answers = [
      '{"r":"Sure.","titles":[{"t":"Hedgehog Morning","y":1993,"k":"movie"}],"do":"admin"}',
    ];
    const { status, body } = await call<{ fix?: unknown }>(
      'POST',
      '/api/v1/ai/chat',
      { message: 'delete this file' }
    );
    assert.equal(status, 200);
    assert.doesNotMatch(calls[0].system, /They are an admin/);
    assert.equal(body.fix, undefined);
    assert.equal(ask.mock.callCount(), 0);
    ask.mock.restore();
  });

  describe('music, for someone who has it', () => {
    const GROUP = '7e41c0d8-5b29-3f6c-b8a4-91d6e2f07a35';
    const OTHER_GROUP = '4f6a2d93-c1e8-3a57-9b02-6d3e8f1c7a40';
    const ARTIST = '3c9e5f21-8d47-4b6a-a1e3-5f7d2c90b844';
    const credit = (name: string) => [{ name, artist: { id: ARTIST, name } }];

    const withMusic = async (run: () => Promise<void>) => {
      const settings = getSettings();
      const saved = settings.lidarr;
      settings.lidarr = [
        { ...((saved[0] ?? {}) as object), id: 0, isDefault: true } as never,
      ];
      mock.method(MusicBrainz.prototype, 'searchReleaseGroups', async () => ({
        count: 2,
        offset: 0,
        'release-groups': [
          // A near miss, ranked first: never taken for the album named.
          {
            id: OTHER_GROUP,
            title: 'Static Garden (Live)',
            score: 100,
            'artist-credit': credit('Glasswing'),
          },
          {
            id: GROUP,
            title: 'Static Garden',
            'primary-type': 'Album',
            'first-release-date': '1997-05-21',
            score: 95,
            'artist-credit': credit('Glasswing'),
          },
        ],
      }));
      mock.method(MusicBrainz.prototype, 'searchArtists', async () => ({
        count: 1,
        offset: 0,
        artists: [{ id: ARTIST, name: 'Glasswing', score: 100 }],
      }));
      try {
        await run();
      } finally {
        settings.lidarr = saved;
      }
    };

    it('finds the albums and artists named, beside films and series', async () =>
      withMusic(async () => {
        answers = [
          '{"r":"An album and its band.","titles":[{"t":"Hedgehog Morning","y":1993,"k":"movie"}],"music":[{"t":"Static Garden","a":"Glasswing","y":1997,"k":"album"},{"t":"Glasswing","k":"artist"},{"t":"Nobody Here","k":"artist"},{"k":"song","t":"x"}]}',
        ];
        const { status, body } = await call<{
          results: { id: number }[];
          music?: {
            albums: { id: string; title: string }[];
            artists: { id: string; name: string }[];
          };
        }>('POST', '/api/v1/ai/chat', { message: 'that 90s album' });
        assert.equal(status, 200);
        assert.deepEqual(
          body.results.map((r) => r.id),
          [137]
        );
        assert.deepEqual(
          body.music?.albums.map((a) => [a.id, a.title]),
          [[GROUP, 'Static Garden']]
        );
        assert.deepEqual(
          body.music?.artists.map((a) => a.name),
          ['Glasswing']
        );
        // Told music is there, and how to give it.
        assert.match(calls[0].system, /"music":/);
      }));

    it('answers music alone without setting up a request for it', async () =>
      withMusic(async () => {
        answers = [
          '{"r":"Here it is.","titles":[],"do":"request","music":[{"t":"Static Garden","a":"Glasswing","k":"album"}]}',
        ];
        const { body } = await call<{
          reply: string;
          action?: unknown;
          music?: { albums: unknown[] };
        }>('POST', '/api/v1/ai/chat', { message: 'request Static Garden' });
        assert.equal(body.reply, 'Here it is.');
        assert.equal(body.action, undefined);
        assert.equal(body.music?.albums.length, 1);
      }));

    it('is neither asked about nor looked up without music', async () => {
      const search = mock.method(
        MusicBrainz.prototype,
        'searchReleaseGroups',
        async () => ({ count: 0, offset: 0, 'release-groups': [] })
      );
      answers = [
        '{"r":"Films only.","titles":[],"music":[{"t":"Static Garden","k":"album"}]}',
      ];
      const { body } = await call<{ music?: unknown }>(
        'POST',
        '/api/v1/ai/chat',
        { message: 'some album' }
      );
      assert.equal(body.music, undefined);
      assert.equal(search.mock.callCount(), 0);
      assert.doesNotMatch(calls[0].system, /"music":/);
    });
  });

  it('ignores an action it does not know', async () => {
    answers = ['{"r":"Done.","titles":[],"do":"delete everything"}'];
    const { status, body } = await call<{ action?: unknown }>(
      'POST',
      '/api/v1/ai/chat',
      { message: 'hmm' }
    );
    assert.equal(status, 200);
    assert.equal(body.action, undefined);
  });

  describe('a whole set, read from TMDB', () => {
    const movie = (id: number, date: string, popularity = 1) => ({
      id,
      title: `Film ${id}`,
      release_date: date,
      media_type: 'movie',
      popularity,
      adult: false,
      genre_ids: [],
      overview: '',
      vote_average: 7,
      vote_count: 1,
      original_language: 'en',
      original_title: `Film ${id}`,
      video: false,
    });

    it('lists every film of a shared universe, oldest first, ready to confirm', async () => {
      stub('searchKeyword', async () => ({
        page: 1,
        total_pages: 1,
        total_results: 2,
        results: [
          { id: 9, name: 'halcyon comics' },
          { id: 291658, name: 'halcyon comics universe' },
        ],
      }));
      const asked: { keywords?: string; page?: number }[] = [];
      stub(
        'getDiscoverMovies',
        async (options: { keywords?: string; page?: number }) => {
          asked.push(options);
          return options.page === 1
            ? {
                page: 1,
                total_pages: 2,
                total_results: 21,
                results: [movie(2, '2012-05-04'), movie(1, '2008-05-02')],
              }
            : {
                page: 2,
                total_pages: 2,
                total_results: 21,
                results: [movie(3, '2019-04-26')],
              };
        }
      );
      answers = [
        '{"r":"Every Halcyon Comics Universe film.","titles":[],"do":"list","src":{"k":"keyword","q":"Halcyon Comics Universe"},"m":"movie"}',
      ];
      const { status, body } = await call<{
        results: { id: number }[];
        source: { name: string; more: boolean };
        action: { do: string; name: string };
      }>('POST', '/api/v1/ai/chat', {
        message: 'add all halcyon movies to a list',
      });

      assert.equal(status, 200);
      // The exact name was chosen over the first result, and every page read.
      assert.deepEqual(
        asked.map((a) => [a.keywords, a.page]),
        [
          ['291658', 1],
          ['291658', 2],
        ]
      );
      assert.deepEqual(
        body.results.map((r) => r.id),
        [1, 2, 3]
      );
      assert.deepEqual(body.source, {
        name: 'Halcyon Comics Universe',
        more: false,
      });
      assert.deepEqual(body.action, {
        do: 'list',
        name: 'Halcyon Comics Universe',
        earlier: false,
      });
    });

    it('keeps the best known when there are more than a list takes', async () => {
      stub('searchCompany', async () => ({
        page: 1,
        total_pages: 1,
        total_results: 1,
        results: [{ id: 41077, name: 'A24' }],
      }));
      stub('getDiscoverMovies', async ({ page }: { page: number }) => ({
        page,
        total_pages: 9,
        total_results: 180,
        results: Array.from({ length: 20 }, (_, i) =>
          movie(page * 100 + i, `20${10 + i}-01-01`, 1000 - page * 20 - i)
        ),
      }));
      answers = [
        '{"r":"A24 films.","titles":[],"src":{"k":"company","q":"A24"},"m":"movie"}',
      ];
      const { body } = await call<{
        results: { id: number }[];
        source: { more: boolean };
        action?: unknown;
      }>('POST', '/api/v1/ai/chat', { message: 'every a24 film' });
      assert.equal(body.results.length, 100);
      assert.equal(body.source.more, true);
      // Nothing to set up unless asked.
      assert.equal(body.action, undefined);
    });

    it("lists a director's films, not what they appeared in", async () => {
      stub('searchPerson', async () => ({
        page: 1,
        total_pages: 1,
        total_results: 1,
        results: [
          {
            id: 525,
            name: 'Adrian Vell',
            popularity: 10,
            known_for_department: 'Directing',
          },
        ],
      }));
      stub('getPersonCombinedCredits', async () => ({
        id: 525,
        cast: [
          { ...movie(50, '2015-01-01'), character: 'Himself' },
          { ...movie(51, '2016-01-01'), character: 'A cameo' },
        ],
        crew: [
          { ...movie(38416, '2010-07-15'), job: 'Director' },
          { ...movie(268447, '2014-11-05'), job: 'Director' },
          { ...movie(60, '2013-01-01'), job: 'Producer' },
        ],
      }));
      answers = [
        '{"r":"Vell\'s films.","titles":[],"do":"request","src":{"k":"person","q":"Adrian Vell","r":"director"},"m":"movie"}',
      ];
      const { body } = await call<{
        results: { id: number }[];
        action: { do: string };
      }>('POST', '/api/v1/ai/chat', { message: 'request all vell films' });
      assert.deepEqual(
        body.results.map((r) => r.id),
        [38416, 268447]
      );
      assert.equal(body.action.do, 'request');
    });

    it('reads the set however a small model puts it', async () => {
      stub('searchPerson', async () => ({
        page: 1,
        total_pages: 1,
        total_results: 1,
        results: [
          {
            id: 525,
            name: 'Adrian Vell',
            popularity: 10,
            known_for_department: 'Directing',
          },
        ],
      }));
      stub('getPersonCombinedCredits', async () => ({
        id: 525,
        cast: [{ ...movie(51, '2016-01-01'), character: 'A cameo' }],
        crew: [{ ...movie(38416, '2010-07-15'), job: 'Director' }],
      }));
      for (const reply of [
        // Flat, as the instructions show.
        '{"r":"Vell.","titles":[],"do":"request","set":"director","of":"Adrian Vell","m":"movie"}',
        // Nested, with its own words for the fields.
        '{"r":"Vell.","titles":[],"do":"request","src":{"kind":"filmography","name":"Adrian Vell","role":"directed"}}',
        // The older shape.
        '{"r":"Vell.","titles":[],"do":"request","src":{"k":"person","q":"Adrian Vell","r":"director"}}',
      ]) {
        clearAiCache();
        answers = [reply];
        const { body } = await call<{
          results: { id: number }[];
          action?: { do: string };
        }>('POST', '/api/v1/ai/chat', { message: 'request all vell films' });
        assert.deepEqual(
          body.results.map((r) => r.id),
          [38416],
          reply
        );
        assert.equal(body.action?.do, 'request', reply);
      }
    });

    it('says what would work when it cannot tell which titles are meant', async () => {
      answers = ['{"r":"Sure.","titles":[],"do":"request"}'];
      const { body } = await call<{
        reply: string;
        results: unknown[];
        action?: unknown;
      }>('POST', '/api/v1/ai/chat', { message: 'request all of them' });
      assert.deepEqual(body.results, []);
      assert.equal(body.action, undefined);
      assert.match(body.reply, /could not tell which titles you mean/);
    });

    it('starts the first posters into the image cache before answering', async () => {
      const fetched: string[] = [];
      const getImage = mock.method(
        ImageProxy.prototype,
        'getImage',
        async (path: string) => {
          fetched.push(path);
          throw new Error('not in a test');
        }
      );
      getSettings().main.cacheImages = true;
      try {
        stub('searchKeyword', async () => ({
          page: 1,
          total_pages: 1,
          total_results: 1,
          results: [{ id: 1, name: 'time loop' }],
        }));
        stub('getDiscoverMovies', async () => ({
          page: 1,
          total_pages: 1,
          total_results: 1,
          results: [{ ...movie(137, '1993-02-11'), poster_path: '/gd.jpg' }],
        }));
        answers = [
          '{"r":"Time loops.","titles":[],"set":"universe","of":"time loop"}',
        ];
        const { status } = await call('POST', '/api/v1/ai/chat', {
          message: 'every time loop film',
        });
        assert.equal(status, 200);
        assert.deepEqual(fetched, ['/t/p/w300_and_h450_face/gd.jpg']);
      } finally {
        getImage.mock.restore();
        getSettings().main.cacheImages = false;
      }
    });

    it('says so when TMDB has nothing by that name', async () => {
      stub('searchCollection', async () => ({
        page: 1,
        total_pages: 0,
        total_results: 0,
        results: [],
      }));
      answers = [
        '{"r":"Here.","titles":[],"do":"list","src":{"k":"collection","q":"Nonexistent Saga"}}',
      ];
      const { body } = await call<{ reply: string; results: unknown[] }>(
        'POST',
        '/api/v1/ai/chat',
        { message: 'all nonexistent saga films' }
      );
      assert.deepEqual(body.results, []);
      assert.match(body.reply, /TMDB has nothing for “Nonexistent Saga”/);
    });
  });

  describe('with a watch history', () => {
    const day = 86_400;
    const now = Math.floor(Date.now() / 1000);
    const play = (over: Record<string, unknown>) => ({
      watched_status: 0,
      percent_complete: 100,
      year: 0,
      ...over,
    });

    beforeEach(async () => {
      // Tautulli is Plex's watch history, read while Plex is connected.
      getSettings().main.mediaServerType = MediaServerType.PLEX;
      getSettings().tautulli = {
        ...getSettings().tautulli,
        hostname: 'tautulli.test',
        apiKey: 'k',
      };
      member.plexId = 42;
      await getRepository(User).save(member);
      Object.defineProperty(TautulliAPI.prototype, 'getUserHistory', {
        configurable: true,
        value: async () => [
          // Part-way through an episode just now: that is what they are
          // watching.
          play({
            media_type: 'episode',
            grandparent_title: 'Outlastia',
            date: now - 600,
            percent_complete: 40,
          }),
          // Opened for a moment: not watched.
          play({
            media_type: 'movie',
            title: 'Glanced At',
            date: now - 700,
            percent_complete: 3,
          }),
          play({
            media_type: 'movie',
            title: 'Hedgehog Morning',
            year: 1993,
            date: now - 3 * day,
          }),
          play({
            media_type: 'episode',
            grandparent_title: 'Outlastia',
            date: now - 5 * day,
          }),
        ],
      });
    });

    after(() => {
      getSettings().main.mediaServerType = MediaServerType.NOT_CONFIGURED;
      getSettings().tautulli = {
        ...getSettings().tautulli,
        hostname: '',
        apiKey: '',
      };
    });

    it('sends it newest first, with when, so "just watched" means something', async () => {
      answers = ['{"r":"You last watched Outlastia, today.","titles":[]}'];
      await call('POST', '/api/v1/ai/chat', {
        message: 'what did I just watch?',
      });
      assert.match(
        calls[0].prompt,
        /Watch history, newest first: Outlastia \(series, today\); Hedgehog Morning \(1993, 3 days ago\)/
      );
      assert.doesNotMatch(calls[0].prompt, /Glanced At/);
    });

    it('still finds a title they watched when they describe it', async () => {
      answers = [
        '{"r":"That is this one.","titles":[{"t":"Hedgehog Morning","y":1993,"k":"movie"}]}',
      ];
      const found = await call<{ results: { id: number }[] }>(
        'POST',
        '/api/v1/ai/chat',
        { message: 'the film I watched where the day repeats' }
      );
      assert.deepEqual(
        found.body.results.map((r) => r.id),
        [137]
      );
    });
  });
});

describe('the daily limit', () => {
  const usesToday = async () =>
    (await getRepository(AiUsage).findOne({ where: { userId: member.id } }))
      ?.uses ?? 0;

  it('cannot be run past by asking many things at once', async () => {
    getSettings().ai.dailyLimit = 2;
    answers = Array.from({ length: 10 }, () => '{"titles":[]}');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        call('POST', '/api/v1/ai/chat', { message: `question ${i}` })
      )
    );
    assert.equal(results.filter((r) => r.status === 200).length, 2);
    assert.equal(results.filter((r) => r.status === 429).length, 8);
    assert.equal(calls.length, 2);
    assert.equal(await usesToday(), 2);
  });

  it('charges a second try at an unreadable answer only once', async () => {
    getSettings().ai.dailyLimit = 5;
    answers = ['not json', '{"titles":[]}'];
    assert.equal(
      (await call('POST', '/api/v1/ai/chat', { message: 'x' })).status,
      200
    );
    assert.equal(await usesToday(), 1);
  });

  it('gives the answer back only when the provider fails', async () => {
    // An answer that cannot be read, even on the second try, still counts:
    // the provider billed for both replies, and handing it back let anyone
    // word every question so the reply could not be read and never use up
    // their answers. An empty answer was billed too.
    getSettings().ai.dailyLimit = 5;
    answers = ['not json', 'still not', '', httpError(500)];
    const unreadable = await call<{ code: string }>('POST', '/api/v1/ai/chat', {
      message: 'x',
    });
    assert.equal(unreadable.status, 502);
    assert.equal(unreadable.body.code, 'unreadable');
    assert.equal(await usesToday(), 1);
    const empty = await call<{ code: string }>('POST', '/api/v1/ai/chat', {
      message: 'y',
    });
    assert.equal(empty.status, 502);
    assert.equal(empty.body.code, 'empty');
    assert.equal(await usesToday(), 2);
    assert.equal(
      (await call('POST', '/api/v1/ai/chat', { message: 'z' })).status,
      503
    );
    assert.equal(await usesToday(), 2);
  });

  describe('with a photo', () => {
    // A JPEG by its first bytes, and nothing a decoder can read.
    const unreadable = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8,
    ]).toString('base64');

    it('is taken before the photo is read, so someone with none left is not given the work', async () => {
      getSettings().ai.dailyLimit = 1;
      const first = await call<{ message: string }>('POST', '/api/v1/ai/chat', {
        message: 'this',
        image: { type: 'image/jpeg', data: unreadable },
      });
      assert.equal(first.status, 400);
      assert.match(first.body.message, /could not be read/);
      // Reading it was the work; the answer it took is kept.
      assert.equal(await usesToday(), 1);
      const second = await call('POST', '/api/v1/ai/chat', {
        message: 'this',
        image: { type: 'image/jpeg', data: unreadable },
      });
      assert.equal(second.status, 429);
      assert.equal(calls.length, 0);
    });

    it('is handed back when the answer comes from memory', async () => {
      getSettings().ai.dailyLimit = 5;
      const jpeg = (
        await sharp({
          create: { width: 32, height: 32, channels: 3, background: '#808080' },
        })
          .jpeg()
          .toBuffer()
      ).toString('base64');
      answers = ['{"r":"","titles":[]}'];
      for (let i = 0; i < 2; i++) {
        const { status } = await call('POST', '/api/v1/ai/chat', {
          message: 'what is this',
          image: { type: 'image/jpeg', data: jpeg },
        });
        assert.equal(status, 200);
      }
      assert.equal(calls.length, 1);
      assert.equal(await usesToday(), 1);
    });

    it('is handed back when the provider fails', async () => {
      getSettings().ai.dailyLimit = 5;
      const jpeg = (
        await sharp({
          create: { width: 32, height: 32, channels: 3, background: '#408040' },
        })
          .jpeg()
          .toBuffer()
      ).toString('base64');
      answers = [httpError(500)];
      const { status } = await call('POST', '/api/v1/ai/chat', {
        message: 'what is this',
        image: { type: 'image/jpeg', data: jpeg },
      });
      assert.equal(status, 503);
      assert.equal(await usesToday(), 0);
    });
  });

  it('stops at the limit and says so', async () => {
    getSettings().ai.dailyLimit = 2;
    answers = ['{"titles":[]}', '{"titles":[]}', '{"titles":[]}'];
    assert.equal(
      (await call('POST', '/api/v1/ai/chat', { message: 'a' })).status,
      200
    );
    assert.equal(
      (await call('POST', '/api/v1/ai/chat', { message: 'b' })).status,
      200
    );
    const third = await call<{
      message: string;
      code: string;
      values: unknown;
    }>('POST', '/api/v1/ai/chat', { message: 'c' });
    assert.equal(third.status, 429);
    assert.match(third.body.message, /all 2 of today's AI answers/);
    // A code the page shows in the person's language.
    assert.equal(third.body.code, 'limit');
    assert.deepEqual(third.body.values, { limit: 2 });
    assert.equal(calls.length, 2);

    const { body } = await call<{ remaining: number }>(
      'GET',
      '/api/v1/ai/status'
    );
    assert.equal(body.remaining, 0);
  });

  it('does not apply to admins', async () => {
    getSettings().ai.dailyLimit = 1;
    actingAs = admin;
    answers = ['{"titles":[]}', '{"titles":[]}'];
    assert.equal(
      (await call('POST', '/api/v1/ai/chat', { message: 'a' })).status,
      200
    );
    assert.equal(
      (await call('POST', '/api/v1/ai/chat', { message: 'b' })).status,
      200
    );
  });

  it('keeps only the last week of counts', async () => {
    getSettings().ai.dailyLimit = 5;
    await getRepository(AiUsage).save(
      new AiUsage({ userId: member.id, day: '2000-01-01', uses: 3 })
    );
    answers = ['{"titles":[]}'];
    await call('POST', '/api/v1/ai/chat', { message: 'a' });
    const rows = await getRepository(AiUsage).find();
    assert.deepEqual(
      rows.map((r) => [r.day, r.uses]),
      [[today(), 1]]
    );
  });
});

describe('who can be included in a pick', () => {
  it('only people who share a watch list, unless you are an admin', async () => {
    const stranger = await makeUser('ai-stranger', Permission.REQUEST);
    const partner = await makeUser('ai-partner', Permission.REQUEST);
    const people = async () =>
      (await call<{ id: number }[]>('GET', '/api/v1/ai/pick/people')).body.map(
        (p) => p.id
      );

    assert.deepEqual(await people(), []);

    const list = await getRepository(MediaList).save(
      new MediaList({ name: 'Ours', ownerId: member.id })
    );
    const membership = await getRepository(MediaListMember).save(
      new MediaListMember({ listId: list.id, userId: partner.id })
    );
    assert.deepEqual(
      await people(),
      [],
      'not until the person it was shared with accepts it'
    );
    actingAs = partner;
    assert.deepEqual(await people(), [], 'either way round');

    await getRepository(MediaListMember).update(membership.id, {
      acceptedAt: new Date(),
    });
    assert.deepEqual(await people(), [member.id]);
    actingAs = member;
    assert.deepEqual(await people(), [partner.id]);

    actingAs = admin;
    const all = await people();
    assert.ok(all.includes(stranger.id) && all.includes(partner.id));
  });

  it('lists them by name, ignoring case', async () => {
    actingAs = admin;
    for (const name of ['zed', 'Bea', 'amy', 'Carl']) {
      await makeUser(name, Permission.REQUEST);
    }
    const names = (
      await call<{ displayName: string }[]>('GET', '/api/v1/ai/pick/people')
    ).body.map((p) => p.displayName);
    const listed = names.filter((n) =>
      ['zed', 'Bea', 'amy', 'Carl'].includes(n)
    );
    assert.deepEqual(listed, ['amy', 'Bea', 'Carl', 'zed']);
    assert.deepEqual(
      names,
      [...names].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
      )
    );
  });
});

describe('catching up on a series', () => {
  it('sends nothing from after the stopping point', async () => {
    answers = ['Previously...'];
    const { status, body } = await call<{ text: string }>(
      'GET',
      '/api/v1/ai/recap/500?season=2&episode=3'
    );
    assert.equal(status, 200);
    assert.equal(body.text, 'Previously...');
    const sent = calls[0].prompt;
    assert.match(sent, /Season 2 episode 2 events/);
    assert.doesNotMatch(sent, /Season 2 episode 3 events/);
    assert.doesNotMatch(sent, /SECRET FUTURE SEASON/);
  });

  it('refuses a series id that cannot be one, without asking anything', async () => {
    for (const id of ['0', '-4', '2.5']) {
      const { status } = await call(
        'GET',
        `/api/v1/ai/recap/${id}?season=2&episode=3`
      );
      assert.equal(status, 400, id);
    }
    assert.equal(calls.length, 0);
  });
});

describe('explaining a log entry', () => {
  it('keeps secrets out of what is sent', async () => {
    actingAs = admin;
    answers = ['It means the key is wrong.'];
    const { status } = await call('POST', '/api/v1/ai/explain-log', {
      label: 'Radarr',
      level: 'error',
      message:
        'Request to http://radarr:7878/api/v3/movie?apikey=abcdef123 failed for someone@example.com',
      data: { apiKey: 'plain-secret', token: 'Bearer abc.def', status: 401 },
    });
    assert.equal(status, 200);
    const sent = calls[0].prompt;
    for (const secret of [
      'abcdef123',
      'plain-secret',
      'abc.def',
      'someone@example.com',
    ]) {
      assert.ok(!sent.includes(secret), secret);
    }
    assert.match(sent, /401/);
  });

  it('redacts secrets in every form they turn up in logs', () => {
    const cases = [
      ['X-Plex-Token: abcdEFGHijklMNOPqrst', 'abcdEFGHijklMNOPqrst'],
      ['login failed password=hunter2', 'hunter2'],
      ['body {"password":"s3cret!"}', 's3cret!'],
      ['Authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
      ['http://admin:pa55@radarr:7878/api', 'pa55'],
      [
        'pushover user u1234567890abcdefghijklmnopq',
        'u1234567890abcdefghijklmnopq',
      ],
      [`id ${'x'.repeat(40)}`, 'x'.repeat(40)],
    ];
    for (const [text, secret] of cases) {
      assert.ok(!(redact(text) as string).includes(secret), text);
    }
    assert.equal(
      redact('Request failed with status code 404'),
      'Request failed with status code 404'
    );
  });

  it('keeps people out of it: their addresses, names and emails', () => {
    const cases: [unknown, string][] = [
      ['Sign-in from 192.168.1.23 failed', '192.168.1.23'],
      [
        'Request from 2001:db8:85a3::8a2e:370:7334 refused',
        '2001:db8:85a3::8a2e:370:7334',
      ],
      ['Request from ::ffff:10.0.0.7 refused', '10.0.0.7'],
      ['Listening on [fe80::1ff:fe23:4567:890a]:5055', 'fe80::1ff'],
      ['User alice_smith has no valid email address', 'alice_smith'],
      ['body {"plexUsername":"bob jones"}', 'jones'],
      ["jellyfinUsername='dan the man'", 'the man'],
      ['login failed password="correct horse battery"', 'battery'],
      [{ ip: 'gateway-7' }, 'gateway-7'],
      [{ plexUsername: 'carol' }, 'carol'],
      [{ displayName: 'Carol King' }, 'King'],
      [{ email: 'carol at home' }, 'carol'],
      [{ user: { name: 'Erin' } }, 'Erin'],
      // As Tautulli's lookups log who they were for.
      [{ user: 'frank_w', userId: 7 }, 'frank_w'],
    ];
    for (const [value, personal] of cases) {
      const sent = JSON.stringify(redact(value));
      assert.ok(!sent.includes(personal), `${JSON.stringify(value)} → ${sent}`);
    }
    // What explains the entry stays.
    for (const kept of [
      'Request failed at 12:34:56 with status code 404',
      'Sonarr v4.0.10 answered in 1.5s',
      'Failed to update user settings',
      'hostname: radarr.local',
      'Plex :: library scan finished',
    ]) {
      assert.equal(redact(kept), kept);
    }
  });

  it('redacts the entry’s label too', async () => {
    actingAs = admin;
    answers = ['Harmless.'];
    await call('POST', '/api/v1/ai/explain-log', {
      label: 'Proxy 203.0.113.9',
      message: 'Request handled',
    });
    assert.ok(!calls[0].prompt.includes('203.0.113.9'), calls[0].prompt);
  });
});

describe('credit', () => {
  interface Report {
    billedBy: string | null;
    outOfCreditAt: string | null;
    hasAdminKey: boolean;
    adminKey?: string;
    balance: number | null;
    source: string;
    providerProblem?: string;
    spentThisMonth: number;
    spentSinceBalance: number | null;
    remaining: number | null;
    unpriced: string[];
    models: {
      model: string;
      requests: number;
      inputTokens: number;
      outputTokens: number;
      cost: number | null;
    }[];
  }

  /** The count of an answer is written just after the answer is sent. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

  const report = async () =>
    (await call<Report>('GET', '/api/v1/settings/ai/credit')).body;

  const creditError = (status: number, error: unknown) =>
    new AxiosError('failed', 'ERR_BAD_REQUEST', undefined, undefined, {
      status,
      data: { type: 'error', error },
      statusText: '',
      headers: {},
      config: { headers: new AxiosHeaders() },
    });

  it("estimates spending from Seerr's own answers at the prices entered", async () => {
    answers = ['{"r":"ok","titles":[]}', '{"r":"ok","titles":[]}'];
    await call('POST', '/api/v1/ai/chat', { message: 'one' });
    await call('POST', '/api/v1/ai/chat', { message: 'two' });
    await settle();

    actingAs = admin;
    let body = await report();
    assert.equal(body.billedBy, 'anthropic');
    assert.equal(body.source, 'estimate');
    const used = body.models.find((m) => m.model === 'claude-test');
    assert.deepEqual(
      used && [used.requests, used.inputTokens, used.outputTokens, used.cost],
      [2, 20, 10, null]
    );
    assert.deepEqual(body.unpriced, ['claude-test']);
    assert.equal(body.remaining, null);

    // $1 in and $10 out per million tokens: 20 in and 10 out cost $0.00012.
    const saved = await call<Report>('POST', '/api/v1/settings/ai/credit', {
      balance: 5,
      prices: { 'claude-test': { input: 1, output: 10 } },
    });
    assert.equal(saved.status, 200);
    body = saved.body;
    assert.deepEqual(body.unpriced, []);
    assert.ok(Math.abs(body.spentThisMonth - 0.00012) < 1e-12);
    // Spending on the day the balance was entered counts against it.
    assert.ok(Math.abs((body.remaining ?? 0) - (5 - 0.00012)) < 1e-12);

    // Forgetting the balance forgets what is left.
    body = (
      await call<Report>('POST', '/api/v1/settings/ai/credit', {
        balance: null,
      })
    ).body;
    assert.equal(body.balance, null);
    assert.equal(body.remaining, null);
  });

  it('notes when the account runs out of credit, and clears it on the next answer', async () => {
    answers = [
      creditError(400, {
        type: 'invalid_request_error',
        message: 'Your credit balance is too low to access the Anthropic API.',
      }),
    ];
    const failed = await call<{ message: string }>('POST', '/api/v1/ai/chat', {
      message: 'broke',
    });
    assert.equal(failed.status, 503);
    assert.match(failed.body.message, /out of credit/);

    actingAs = admin;
    assert.ok((await report()).outOfCreditAt);

    actingAs = member;
    answers = ['{"r":"ok","titles":[]}'];
    assert.equal(
      (await call('POST', '/api/v1/ai/chat', { message: 'topped up' })).status,
      200
    );
    actingAs = admin;
    assert.equal((await report()).outOfCreditAt, null);
  });

  it("reads OpenAI's own report with an admin key it never hands back", async () => {
    setUp({ provider: 'openai', model: 'gpt-test', apiKey: 'openai-key' });
    actingAs = admin;
    const asked: { url: string; auth?: string; page?: string }[] = [];
    const get = mock.method(
      axios,
      'get',
      async (
        url: string,
        config: {
          headers: Record<string, string>;
          params: { page?: string };
        }
      ) => {
        asked.push({
          url,
          auth: config.headers.authorization,
          page: config.params.page,
        });
        if (config.headers.authorization !== 'Bearer sk-admin-good') {
          throw httpError(401);
        }
        // Two pages: the second is followed.
        return config.params.page
          ? {
              data: {
                data: [{ results: [{ amount: { value: 0.25 } }] }],
                has_more: false,
                next_page: null,
              },
            }
          : {
              data: {
                data: [
                  {
                    results: [
                      { amount: { value: 1.5 } },
                      { amount: { value: 0.25 } },
                    ],
                  },
                ],
                has_more: true,
                next_page: 'page_2',
              },
            };
      }
    );
    try {
      const refused = await call<{ message: string }>(
        'POST',
        '/api/v1/settings/ai/credit',
        { adminKey: 'sk-proj-not-admin' }
      );
      assert.equal(refused.status, 400);
      assert.match(refused.body.message, /rejected the admin key/);
      assert.equal(getSettings().aiCredit.adminKey, '');

      const saved = await call<Report>('POST', '/api/v1/settings/ai/credit', {
        adminKey: 'sk-admin-good',
        balance: 10,
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.body.hasAdminKey, true);
      assert.equal(saved.body.source, 'provider');
      assert.equal(saved.body.spentThisMonth, 2);
      assert.equal(saved.body.remaining, 8);
      assert.ok(asked.some((a) => a.page === 'page_2'));
      assert.ok(
        asked.every(
          (a) => a.url === 'https://api.openai.com/v1/organization/costs'
        )
      );

      // Never sent back, from either settings page.
      const raw = JSON.stringify([
        (await call('GET', '/api/v1/settings/ai/credit')).body,
        (await call('GET', '/api/v1/settings/ai')).body,
      ]);
      assert.ok(!raw.includes('sk-admin-good'));
    } finally {
      get.mock.restore();
    }
  });

  it("reads Anthropic's cost report in cents", async () => {
    actingAs = admin;
    const get = mock.method(axios, 'get', async () => ({
      data: {
        data: [{ results: [{ amount: '150' }, { amount: '25.5' }] }],
        has_more: false,
        next_page: null,
      },
    }));
    try {
      const saved = await call<Report>('POST', '/api/v1/settings/ai/credit', {
        adminKey: 'sk-ant-admin01-good',
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.body.spentThisMonth, 1.755);
    } finally {
      get.mock.restore();
    }
  });

  it('shows the estimate, and why, when the report cannot be read', async () => {
    actingAs = admin;
    getSettings().aiCredit.adminKey = 'sk-ant-admin01-revoked';
    const get = mock.method(axios, 'get', async () => {
      throw httpError(403);
    });
    try {
      const body = await report();
      assert.equal(body.source, 'estimate');
      assert.match(body.providerProblem ?? '', /organization accounts/);
    } finally {
      get.mock.restore();
    }
  });

  it("counts the provider's month from the 1st in UTC, wherever the server is", async () => {
    actingAs = admin;
    getSettings().aiCredit.adminKey = 'sk-ant-admin01-good';
    const since: string[] = [];
    const get = mock.method(
      axios,
      'get',
      async (_url: string, config: { params: { starting_at: string } }) => {
        since.push(config.params.starting_at);
        return { data: { data: [], has_more: false, next_page: null } };
      }
    );
    const zone = process.env.TZ;
    try {
      // East of UTC, local midnight on the 1st is still the last day of
      // the month before in UTC.
      process.env.TZ = 'Australia/Sydney';
      const report = await creditReport(new Date('2026-10-15T00:00:00Z'));
      assert.equal(report.monthStart, '2026-10-01');
      assert.deepEqual(since, ['2026-10-01T00:00:00.000Z']);

      // In the first hours of the month there, the UTC month has not
      // begun: nothing has been spent in it yet.
      forgetSpendReports();
      since.length = 0;
      const early = await creditReport(new Date('2026-09-30T15:00:00Z'));
      assert.equal(early.monthStart, '2026-10-01');
      assert.equal(early.spentThisMonth, 0);
      assert.deepEqual(since, []);
    } finally {
      if (zone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = zone;
      }
      get.mock.restore();
    }
  });

  it('starts again for another provider, and does not bill a home server', async () => {
    actingAs = admin;
    getSettings().aiCredit = {
      adminKey: 'sk-ant-admin01-old',
      balance: 12,
      balanceAt: new Date().toISOString(),
      prices: { 'claude-test': { input: 1, output: 5 } },
      outOfCreditAt: new Date().toISOString(),
    };
    // Saved turned off, so it is not tested against the fake model.
    const moved = await call('POST', '/api/v1/settings/ai', {
      enabled: false,
      provider: 'openai',
      apiKey: '',
      baseUrl: 'http://ollama.local:11434/v1',
      model: 'llama',
      featureModels: {},
      dailyLimit: 0,
    });
    assert.equal(moved.status, 200);
    const credit = getSettings().aiCredit;
    assert.deepEqual(
      [credit.adminKey, credit.balance, credit.outOfCreditAt],
      ['', null, null]
    );
    // Prices are per model, and kept.
    assert.deepEqual(credit.prices, {
      'claude-test': { input: 1, output: 5 },
    });

    assert.equal((await report()).billedBy, null);
    const refused = await call('POST', '/api/v1/settings/ai/credit', {
      balance: 3,
    });
    assert.equal(refused.status, 400);
  });
});
