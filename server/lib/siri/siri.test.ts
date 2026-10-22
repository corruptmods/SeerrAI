import TheMovieDb from '@server/api/themoviedb';
import { IssueType } from '@server/constants/issue';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Issue from '@server/entity/Issue';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { clearAiCache } from '@server/lib/ai';
import { ANTHROPIC_URL } from '@server/lib/ai/providers';
import autofix from '@server/lib/autofix';
import type { NowPlaying } from '@server/lib/nowPlaying';
import nowPlaying from '@server/lib/nowPlaying';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import siri, { parseItem, spokenName } from '@server/lib/siri';
import { isAuthenticated } from '@server/middleware/auth';
import nowPlayingRoutes from '@server/routes/nowPlaying';
import { IssueCommentSubscriber } from '@server/subscriber/IssueCommentSubscriber';
import { IssueSubscriber } from '@server/subscriber/IssueSubscriber';
import { setupTestDb } from '@server/test/db';
import axios from 'axios';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';

/*
 * "Fix this show" through the real API validator: what is playing, the
 * report, and the yes or no to a fix that replaces files. What is playing
 * and the fixes themselves are stubbed; what is filed is checked.
 */

setupTestDb();

let server: Server | undefined;
let port = 0;
let actingAs: User;
let viewer: User;
let admin: User;
let bear: Media;
let film: Media;
let playing: NowPlaying[] = [];
let started: { issueId: number; kind?: string; language?: string }[] = [];
let modelAsked: { system: string; prompt: string }[] = [];
let modelAnswer = '{"kind":"unclear"}';

const call = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const episode = (season = 2, number = 3): NowPlaying => ({
  media: bear,
  title: 'The Otterkin',
  season,
  episode: number,
  seen: 'now',
  paused: false,
  server: 'plex',
});

const issues = () =>
  getRepository(Issue).find({
    relations: { comments: true, media: true, createdBy: true },
    order: { id: 'ASC' },
  });

beforeEach(async () => {
  siri.reset();
  clearAiCache();
  started = [];
  modelAsked = [];
  modelAnswer = '{"kind":"unclear"}';
  const settings = getSettings();
  settings.main.disabledFeatures = [];
  settings.ai = { ...settings.ai, enabled: false };
  const users = getRepository(User);
  viewer = await users.save(
    new User({
      email: 'siri-viewer@test.local',
      plexUsername: 'siri-viewer',
      permissions: Permission.REQUEST | Permission.CREATE_ISSUES,
      avatar: '',
    })
  );
  admin = await users.findOneByOrFail({ id: 1 });
  actingAs = viewer;
  const media = getRepository(Media);
  bear = await media.save(
    new Media({
      tmdbId: 247426,
      mediaType: MediaType.TV,
      status: MediaStatus.AVAILABLE,
    })
  );
  film = await media.save(
    new Media({
      tmdbId: 137,
      mediaType: MediaType.MOVIE,
      status: MediaStatus.AVAILABLE,
    })
  );
  playing = [episode()];
  mock.method(nowPlaying, 'playingFor', async () => playing);
  mock.method(
    autofix,
    'fromIssue',
    async (
      issueId: number,
      options: { asked?: { kind: string; language?: string } }
    ) => {
      started.push({
        issueId,
        kind: options.asked?.kind,
        language: options.asked?.language,
      });
      return undefined;
    }
  );
  mock.method(
    IssueSubscriber.prototype as unknown as {
      sendIssueNotification: () => Promise<void>;
    },
    'sendIssueNotification',
    async () => undefined
  );
  mock.method(
    IssueCommentSubscriber.prototype as unknown as {
      sendIssueCommentNotification: () => Promise<void>;
    },
    'sendIssueCommentNotification',
    async () => undefined
  );
  mock.method(
    axios,
    'post',
    async (url: string, body: { system: string; messages: unknown[] }) => {
      assert.equal(url, `${ANTHROPIC_URL}/messages`);
      modelAsked.push({
        system: body.system,
        prompt: JSON.stringify(body.messages),
      });
      return {
        data: {
          content: [{ type: 'text', text: modelAnswer }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
    }
  );

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
    app.use('/api/v1/now-playing', isAuthenticated(), nowPlayingRoutes);
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

afterEach(() => {
  mock.restoreAll();
  delete (TheMovieDb.prototype as unknown as { getTvShow?: unknown }).getTvShow;
  getSettings().main.disabledFeatures = [];
  getSettings().ai = { ...getSettings().ai, enabled: false };
});
after(() => {
  server?.closeAllConnections();
  server?.close();
});

const turnOnAi = () => {
  getSettings().ai = {
    enabled: true,
    provider: 'anthropic',
    apiKey: 'test-key',
    baseUrl: '',
    model: 'claude-test',
    featureModels: {},
    dailyLimit: 0,
  };
};

describe('Siri: what is playing', () => {
  it('asks about the first title, and says which to send back', async () => {
    const { status, body } = await call('GET', '/now-playing');
    assert.equal(status, 200, body.message);
    assert.equal(
      body.say,
      'What’s wrong with The Otterkin, season 2 episode 3?'
    );
    assert.equal(body.item, `${bear.id}:2:3`);
    assert.equal(body.playing[0].mediaType, 'tv');
  });

  it('says so when nothing is playing', async () => {
    playing = [];
    const { status, body } = await call('GET', '/now-playing');
    assert.equal(status, 200);
    assert.equal(body.item, undefined);
    assert.match(body.say, /^Nothing is playing for you/);
  });

  it('is off, out loud, when an admin turns it off', async () => {
    getSettings().main.disabledFeatures = ['siri'];
    const { status, body } = await call('GET', '/now-playing');
    assert.equal(status, 403);
    assert.equal(body.say, 'Reporting with Siri is turned off.');
  });

  it('names films and episodes as Siri says them', () => {
    assert.equal(spokenName({ title: 'Hedgehog Morning' }), 'Hedgehog Morning');
    assert.equal(
      spokenName({ title: 'The Otterkin', season: 2 }),
      'The Otterkin, season 2'
    );
    assert.deepEqual(parseItem('12:2:3'), {
      mediaId: 12,
      season: 2,
      episode: 3,
    });
    assert.deepEqual(parseItem('12:2:'), { mediaId: 12, season: 2 });
    assert.deepEqual(parseItem('12'), { mediaId: 12 });
    assert.equal(parseItem('12; drop table'), undefined);
  });
});

describe('Siri: a report', () => {
  it('files subtitles as an issue and starts on them at once', async () => {
    await call('GET', '/now-playing');
    const { status, body } = await call('POST', '/now-playing/report', {
      problem: 'the Spanish subtitles are missing',
      item: `${bear.id}:2:3`,
    });
    assert.equal(status, 200, body.message);
    assert.equal(
      body.say,
      'Reported. I’m looking for Spanish subtitles now. You’ll be told how it goes.'
    );
    const [issue] = await issues();
    assert.equal(issue.id, body.issueId);
    assert.equal(issue.issueType, IssueType.SUBTITLES);
    assert.equal(issue.problemSeason, 2);
    assert.equal(issue.problemEpisode, 3);
    assert.equal(issue.createdBy.id, viewer.id);
    assert.equal(
      issue.comments[0].message,
      'the Spanish subtitles are missing'
    );
    assert.deepEqual(started, [
      { issueId: issue.id, kind: 'subtitles', language: 'es' },
    ]);
  });

  it('asks before replacing a file, and does it on a yes', async () => {
    // Sent back without asking what is playing first: named from TMDB.
    // TMDB sets its methods on each instance: answered from the prototype.
    Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
      configurable: true,
      set() {},
      get: () => async () => ({ name: 'The Otterkin' }),
    });
    const asked = await call('POST', '/now-playing/report', {
      problem: 'it keeps freezing',
      item: `${bear.id}:2:3`,
    });
    assert.equal(asked.status, 200, asked.body.message);
    assert.equal(
      asked.body.say,
      'That replaces the file of The Otterkin, season 2 episode 3 with another copy. Should I go ahead?'
    );
    assert.ok(asked.body.confirm);
    assert.equal((await issues()).length, 0, 'nothing filed before the yes');

    const yes = await call('POST', '/now-playing/answer', {
      confirm: asked.body.confirm,
      answer: 'Yes',
    });
    assert.equal(yes.status, 200, yes.body.message);
    assert.match(
      yes.body.say,
      /^Reported\. Another copy will replace the file/
    );
    const [issue] = await issues();
    assert.equal(issue.issueType, IssueType.VIDEO);
    assert.equal(issue.problemEpisode, 3);
    assert.deepEqual(started, [
      { issueId: issue.id, kind: 'broken', language: undefined },
    ]);

    // Answered once: not again.
    const again = await call('POST', '/now-playing/answer', {
      confirm: asked.body.confirm,
      answer: 'yes',
    });
    assert.equal(again.status, 410);
    assert.match(again.body.say, /run out/);
  });

  it('reports it for an admin on a no, and leaves the files alone', async () => {
    const asked = await call('POST', '/now-playing/report', {
      problem: 'this is the wrong episode',
    });
    assert.match(asked.body.say, /checks The Otterkin, season 2 episode 3/);
    const no = await call('POST', '/now-playing/answer', {
      confirm: asked.body.confirm,
      answer: 'no',
    });
    assert.equal(no.status, 200);
    assert.match(no.body.say, /left the files as they are/);
    assert.equal((await issues()).length, 1);
    assert.deepEqual(started, []);
  });

  it('keeps one question waiting a person: a new one replaces the last', async () => {
    const first = await call('POST', '/now-playing/report', {
      problem: 'it keeps freezing',
    });
    const second = await call('POST', '/now-playing/report', {
      problem: 'this is the wrong episode',
    });
    const old = await call('POST', '/now-playing/answer', {
      confirm: first.body.confirm,
      answer: 'yes',
    });
    assert.equal(old.status, 410);
    const yes = await call('POST', '/now-playing/answer', {
      confirm: second.body.confirm,
      answer: 'yes',
    });
    assert.equal(yes.status, 200);
    assert.equal((await issues()).length, 1);
  });

  it('keeps someone else’s question to them', async () => {
    const asked = await call('POST', '/now-playing/report', {
      problem: 'it keeps freezing',
    });
    actingAs = admin;
    const theirs = await call('POST', '/now-playing/answer', {
      confirm: asked.body.confirm,
      answer: 'yes',
    });
    assert.equal(theirs.status, 410);
    assert.equal((await issues()).length, 0);
  });

  it('asks an admin to approve a whole season, for someone else', async () => {
    const asked = await call('POST', '/now-playing/report', {
      problem: 'the whole season is messed up',
    });
    assert.equal(
      asked.body.say,
      'That asks an admin to replace all of season 2 of The Otterkin. Should I ask?'
    );
    await call('POST', '/now-playing/answer', {
      confirm: asked.body.confirm,
      answer: 'yes',
    });
    const [issue] = await issues();
    assert.equal(issue.problemSeason, 2);
    assert.equal(issue.problemEpisode, 0, 'the season, not the episode');
    assert.equal(started[0].kind, 'replaceSeason');
  });

  it('takes the season they name over the one playing', async () => {
    const asked = await call('POST', '/now-playing/report', {
      problem: 'season 1 is completely messed up, replace it',
    });
    assert.match(asked.body.say, /all of season 1 of The Otterkin/);
  });

  it('replaces a film’s one file for "the whole thing"', async () => {
    playing = [
      {
        ...episode(),
        media: film,
        title: 'Hedgehog Morning',
        season: undefined,
        episode: undefined,
      },
    ];
    const asked = await call('POST', '/now-playing/report', {
      problem: 'the whole season is messed up',
    });
    assert.equal(
      asked.body.say,
      'That replaces the file of Hedgehog Morning with another copy. Should I go ahead?'
    );
  });

  it('reports what it can’t read for an admin, saying what would work', async () => {
    const { body } = await call('POST', '/now-playing/report', {
      problem: 'something feels off about it',
    });
    assert.match(body.say, /^I reported it for an admin\. I couldn’t tell/);
    const [issue] = await issues();
    assert.equal(issue.issueType, IssueType.OTHER);
    assert.deepEqual(started, []);
    assert.equal(modelAsked.length, 0, 'no model set up, none asked');
  });

  it('asks the model what the rules can’t read, sending only the words', async () => {
    turnOnAi();
    modelAnswer = '{"kind":"subtitles","language":"fr","wrongSubtitles":true}';
    const { body } = await call('POST', '/now-playing/report', {
      problem: 'the people talk but the words at the bottom are in french',
    });
    assert.match(body.say, /French subtitles/);
    assert.equal(modelAsked.length, 1);
    assert.match(
      modelAsked[0].prompt,
      /the people talk but the words at the bottom are in french/
    );
    assert.doesNotMatch(modelAsked[0].prompt, /The Otterkin|siri-viewer/);
    assert.deepEqual(
      started.map((s) => [s.kind, s.language]),
      [['subtitles', 'fr']]
    );
  });

  it('still asks first when the model reads it as replacing files', async () => {
    turnOnAi();
    modelAnswer = '{"kind":"wrongEpisode"}';
    const { body } = await call('POST', '/now-playing/report', {
      problem: 'this isn’t what it says it is',
    });
    assert.ok(body.confirm);
    assert.equal((await issues()).length, 0);
  });

  it('leaves the model out when Understand Reports is off', async () => {
    turnOnAi();
    getSettings().main.disabledFeatures = ['aiReports'];
    await call('POST', '/now-playing/report', {
      problem: 'something feels off about it',
    });
    assert.equal(modelAsked.length, 0);
  });

  it('files it, without a fix, when auto-fix is off', async () => {
    getSettings().main.disabledFeatures = ['autoFix'];
    const { body } = await call('POST', '/now-playing/report', {
      problem: 'it keeps freezing',
    });
    assert.equal(body.say, 'I reported it for an admin.');
    assert.equal(body.confirm, undefined);
    assert.equal((await issues()).length, 1);
    assert.deepEqual(started, []);
  });

  it('doesn’t file the same thing twice in a day', async () => {
    await call('POST', '/now-playing/report', {
      problem: 'subtitles are out of sync',
    });
    const again = await call('POST', '/now-playing/report', {
      problem: 'the subtitles are still out of sync',
    });
    assert.match(again.body.say, /reported that already today/);
    assert.equal((await issues()).length, 1);
  });

  it('needs permission to report problems, and something said', async () => {
    const empty = await call('POST', '/now-playing/report', { problem: '  ' });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.say, 'Say what’s wrong with it.');
    actingAs = await getRepository(User).save(
      new User({
        email: 'siri-request-only@test.local',
        plexUsername: 'siri-request-only',
        permissions: Permission.REQUEST,
        avatar: '',
      })
    );
    const refused = await call('POST', '/now-playing/report', {
      problem: 'subtitles are out of sync',
    });
    assert.equal(refused.status, 403);
    assert.match(refused.body.say, /permission to report problems/);
  });

  it('says so when nothing is playing', async () => {
    playing = [];
    const { status, body } = await call('POST', '/now-playing/report', {
      problem: 'subtitles are out of sync',
    });
    assert.equal(status, 404);
    assert.match(body.say, /Nothing is playing/);
  });
});
