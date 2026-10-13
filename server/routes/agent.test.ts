import { getRepository } from '@server/datasource';
import AgentRun from '@server/entity/AgentRun';
import BackfillJob from '@server/entity/BackfillJob';
import BackfillSeries from '@server/entity/BackfillSeries';
import { User } from '@server/entity/User';
import agent from '@server/lib/agent';
import BackfillSonarr from '@server/lib/backfill/sonarr';
import { Permission } from '@server/lib/permissions';
import type { SonarrSettings } from '@server/lib/settings';
import { BACKFILL_DEFAULTS, getSettings } from '@server/lib/settings';
import { isAuthenticated } from '@server/middleware/auth';
import agentRoutes from '@server/routes/agent';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';

setupTestDb();

/* The agent's routes, behind the real validator and the admin check. */

let app: Server | undefined;
let port = 0;
let actingAs: User;

const call = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

beforeEach(async () => {
  getSettings().backfill = { ...BACKFILL_DEFAULTS };
  getSettings().ai = { ...getSettings().ai, enabled: false };
  actingAs = await getRepository(User).findOneOrFail({ where: { id: 1 } });
  if (!app) {
    const ex = express();
    ex.use(express.json());
    ex.use(
      OpenApiValidator.middleware({
        apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
        validateRequests: true,
        validateSecurity: false,
      })
    );
    ex.use((req, _res, next) => {
      (req as unknown as { user: User }).user = actingAs;
      next();
    });
    ex.use('/api/v1/agent', isAuthenticated(Permission.ADMIN), agentRoutes);
    ex.use(
      (
        err: { status?: number; message: string },
        _req: express.Request,
        res: express.Response,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _next: express.NextFunction
      ) => res.status(err.status ?? 500).json({ message: err.message })
    );
    app = await new Promise<Server>((resolve) => {
      const s = ex.listen(0, () => resolve(s));
    });
    port = (app.address() as { port: number }).port;
  }
});

afterEach(() => mock.restoreAll());
after(() => app?.close());

describe('the admin agent’s routes', () => {
  it('are for admins only', async () => {
    actingAs = await getRepository(User).save(
      new User({
        email: 'agent-member@test.local',
        permissions: Permission.MANAGE_REQUESTS,
        avatar: '',
      })
    );
    assert.equal((await call('GET', '/api/v1/agent')).status, 403);
  });

  it('list runs newest first, and say why it cannot run', async () => {
    await getRepository(AgentRun).save([
      new AgentRun({
        trigger: 'auto',
        status: 'done',
        title: 'Old',
        steps: [],
        actions: [],
      }),
      new AgentRun({
        trigger: 'ask',
        status: 'done',
        ask: 'Find Casper',
        title: 'Casper the Friendly Ghost',
        summary: 'Grabbed two.',
        steps: [
          { at: '2026-10-07T20:00:00.000Z', kind: 'say', text: 'Looking.' },
        ],
        actions: [],
      }),
    ]);
    const { status, body } = await call('GET', '/api/v1/agent');
    assert.equal(status, 200);
    assert.match(body.problem, /Settings → AI/);
    assert.deepEqual(
      body.runs.map((r: { title: string; steps: number }) => [
        r.title,
        r.steps,
      ]),
      [
        ['Casper the Friendly Ghost', 1],
        ['Old', 0],
      ]
    );
    const detail = await call('GET', `/api/v1/agent/${body.runs[0].id}`);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body.steps, [
      { at: '2026-10-07T20:00:00.000Z', kind: 'say', text: 'Looking.' },
    ]);
    assert.equal((await call('GET', '/api/v1/agent/9999')).status, 404);
  });

  it('take a request only when the agent can run', async () => {
    assert.equal(
      (await call('POST', '/api/v1/agent/ask', { text: 'x' })).status,
      400
    );
    const refused = await call('POST', '/api/v1/agent/ask', {
      text: 'Find Casper',
    });
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /Admin Agent/);

    const asked: string[] = [];
    mock.method(agent, 'ask', async (text: string) => {
      asked.push(text);
      return getRepository(AgentRun).save(
        new AgentRun({
          trigger: 'ask',
          status: 'queued',
          ask: text,
          steps: [],
          actions: [],
        })
      );
    });
    const ok = await call('POST', '/api/v1/agent/ask', {
      text: '  Find Casper  ',
    });
    assert.equal(ok.status, 202);
    assert.equal(ok.body.status, 'queued');
    assert.deepEqual(asked, ['Find Casper']);
  });

  it('take a reply to a conversation that is not busy', async () => {
    const replied: [number, string][] = [];
    mock.method(agent, 'reply', async (id: number, text: string) => {
      replied.push([id, text]);
      return getRepository(AgentRun).save(
        new AgentRun({
          trigger: 'ask',
          status: 'queued',
          ask: 'x',
          steps: [],
          actions: [],
        })
      );
    });
    assert.equal(
      (await call('POST', '/api/v1/agent/7/reply', { text: '' })).status,
      400
    );
    const ok = await call('POST', '/api/v1/agent/7/reply', {
      text: 'Check it is English first',
    });
    assert.equal(ok.status, 202);
    assert.deepEqual(replied, [[7, 'Check it is English first']]);
  });

  it('ask about one title from its page, and list only its conversations', async () => {
    getSettings().sonarr = [
      {
        id: 0,
        name: 'Sonarr',
        hostname: 'sonarr',
        port: 8989,
        apiKey: 'x',
        useSsl: false,
        is4k: false,
        isDefault: true,
      } as unknown as SonarrSettings,
    ];
    mock.method(
      BackfillSonarr.prototype,
      'getSeriesDetail',
      async (id: number) => {
        if (id !== 1284) throw new Error('Not found');
        return { id, title: 'Food Wars!' };
      }
    );
    const asked: [string, unknown][] = [];
    mock.method(
      agent,
      'ask',
      async (text: string, _user: User, about?: { name: string }) => {
        asked.push([text, about]);
        return getRepository(AgentRun).save(
          new AgentRun({
            trigger: 'ask',
            status: 'queued',
            ask: text,
            kind: 'series',
            serverId: 0,
            arrId: 1284,
            title: about?.name ?? null,
            steps: [],
            actions: [],
          })
        );
      }
    );
    const title = { kind: 'series', serverId: 0, arrId: 1284 };
    const ok = await call('POST', '/api/v1/agent/ask', { text: '', title });
    assert.equal(ok.status, 202, ok.body?.message);
    assert.deepEqual(asked, [
      [
        'Get whatever is missing.',
        {
          title: { kind: 'series', serverId: 0, arrId: 1284 },
          name: 'Food Wars!',
        },
      ],
    ]);
    const unknown = await call('POST', '/api/v1/agent/ask', {
      title: { ...title, arrId: 9 },
    });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.message, /not in Sonarr or Radarr/);

    await getRepository(AgentRun).save(
      new AgentRun({
        trigger: 'ask',
        status: 'done',
        ask: 'Find Casper',
        kind: 'series',
        serverId: 0,
        arrId: 1283,
        steps: [],
        actions: [],
      })
    );
    const mine = await call(
      'GET',
      '/api/v1/agent?kind=series&serverId=0&arrId=1284'
    );
    assert.equal(mine.status, 200);
    assert.deepEqual(
      mine.body.runs.map((r: { title: string }) => r.title),
      ['Food Wars!']
    );
    assert.equal((await call('GET', '/api/v1/agent')).body.total, 2);
  });

  it('keep a conversation whose downloads are still going', async () => {
    const series = await getRepository(BackfillSeries).save(
      new BackfillSeries({
        kind: 'series',
        serverId: 0,
        arrId: 5,
        title: 'Casper',
        status: 'downloading',
      })
    );
    const job = (status: BackfillJob['status']) =>
      new BackfillJob({
        seriesId: series.id,
        candidateId: null,
        title: 'x',
        status,
        mode: 'missing',
        protocol: 'torrent',
        clientId: 1,
        files: [],
        size: 1,
        sizeLeft: 1,
        commandIds: [],
        log: [],
      });
    const [going, imported] = await getRepository(BackfillJob).save([
      job('downloading'),
      job('done'),
    ]);
    const runs = getRepository(AgentRun);
    const grabbed = (jobId: number) =>
      new AgentRun({
        trigger: 'ask',
        status: 'done',
        ask: 'x',
        steps: [],
        actions: [
          {
            at: new Date().toISOString(),
            type: 'grab',
            title: 'Casper',
            detail: 'x',
            jobId,
          },
        ],
      });
    const [busy, over] = await runs.save([
      grabbed(going.id),
      grabbed(imported.id),
    ]);
    const refused = await call('DELETE', `/api/v1/agent/${busy.id}`);
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /downloads are still going/);
    const cleared = await call('POST', '/api/v1/agent/clear');
    assert.deepEqual(cleared.body, { deleted: 1 });
    assert.deepEqual(
      (await runs.find()).map((r) => r.id),
      [busy.id]
    );
    assert.equal(await runs.count({ where: { id: over.id } }), 0);
  });

  it('delete a conversation or every finished one, never one at work', async () => {
    const runs = getRepository(AgentRun);
    const [done, , waiting, working] = await runs.save(
      (['done', 'failed', 'waiting', 'running'] as const).map(
        (status) =>
          new AgentRun({
            trigger: 'ask',
            status,
            ask: status,
            steps: [],
            actions: [],
          })
      )
    );
    const busy = await call('DELETE', `/api/v1/agent/${working.id}`);
    assert.equal(busy.status, 409);
    assert.match(busy.body.message, /working on this one/);
    assert.equal((await call('DELETE', '/api/v1/agent/9999')).status, 404);

    assert.equal(
      (await call('DELETE', `/api/v1/agent/${done.id}`)).status,
      204
    );
    assert.equal(await runs.count({ where: { id: done.id } }), 0);

    // Counted across every page, so Clear finished is offered from any.
    const later = await call('GET', '/api/v1/agent?page=1');
    assert.deepEqual([later.body.runs.length, later.body.finished], [0, 1]);

    const cleared = await call('POST', '/api/v1/agent/clear');
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.body, { deleted: 1 });
    assert.equal((await call('GET', '/api/v1/agent')).body.finished, 0);
    assert.deepEqual(
      (await runs.find({ order: { id: 'ASC' } })).map((r) => r.id),
      [waiting.id, working.id]
    );
  });
});
