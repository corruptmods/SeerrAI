import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import AgentRun from '@server/entity/AgentRun';
import BackfillJob from '@server/entity/BackfillJob';
import BackfillSeries from '@server/entity/BackfillSeries';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import backfillStatusRoutes from '@server/routes/backfillStatus';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

setupTestDb();

/*
 * What the person who asked for a title is told about Backfill: that it is
 * looking, or downloading, for their own requests only.
 */

let server: Server;
let base: string;
let actingAs: User;

before(async () => {
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
  app.use('/api/v1/backfill-status', backfillStatusRoutes);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server?.close());

beforeEach(() => {
  getSettings().backfill = { ...getSettings().backfill, enabled: true };
});

const user = (name: string) =>
  getRepository(User).save(
    new User({
      email: `${name}@test.local`,
      plexUsername: name,
      permissions: Permission.REQUEST,
      avatar: '',
    })
  );

const requested = async (by: User, tmdbId: number, mediaType: MediaType) => {
  const media = await getRepository(Media).save(
    new Media({
      tmdbId,
      mediaType,
      status: MediaStatus.PROCESSING,
      status4k: MediaStatus.UNKNOWN,
    })
  );
  await getRepository(MediaRequest).save(
    new MediaRequest({
      media,
      type: mediaType,
      status: MediaRequestStatus.APPROVED,
      requestedBy: by,
      is4k: false,
    }),
    { listeners: false }
  );
};

const tracked = (tmdbId: number, kind: 'series' | 'movie', arrId: number) =>
  getRepository(BackfillSeries).save(
    new BackfillSeries({
      kind,
      serverId: 0,
      arrId,
      tmdbId,
      title: `Title ${tmdbId}`,
      status: 'stuck',
    })
  );

const statusFor = async (ids: number[]) => {
  const res = await fetch(
    `${base}/api/v1/backfill-status?tmdbIds=${ids.join(',')}`
  );
  assert.equal(res.status, 200);
  return res.json();
};

describe('Backfill on someone’s own requests', () => {
  it('says it is looking, or downloading, for what they asked for only', async () => {
    const asker = await user('asker');
    const other = await user('other');
    await requested(asker, 10, MediaType.TV);
    await requested(asker, 20, MediaType.MOVIE);
    await requested(other, 30, MediaType.MOVIE);
    await tracked(10, 'series', 1);
    const movie = await tracked(20, 'movie', 2);
    await tracked(30, 'movie', 3);
    // A series with the movie's TMDB id is another title.
    await tracked(20, 'series', 4);
    await getRepository(BackfillJob).save(
      new BackfillJob({
        seriesId: movie.id,
        title: 'pack',
        status: 'downloading',
        mode: 'missing',
        protocol: 'torrent',
        clientId: 1,
        progress: 42,
        files: [],
      })
    );

    actingAs = asker;
    assert.deepEqual(
      (await statusFor([10, 20, 30])).sort(
        (a: { tmdbId: number }, b: { tmdbId: number }) => a.tmdbId - b.tmdbId
      ),
      [
        { tmdbId: 10, mediaType: 'tv', state: 'looking', agent: false },
        {
          tmdbId: 20,
          mediaType: 'movie',
          state: 'downloading',
          progress: 42,
          agent: false,
        },
      ]
    );

    actingAs = other;
    assert.deepEqual(await statusFor([10, 20]), []);
  });

  it('says when the admin agent is looking, and shows an admin everyone’s', async () => {
    const asker = await user('asker3');
    const admin = await getRepository(User).save(
      new User({
        email: 'admin3@test.local',
        plexUsername: 'admin3',
        permissions: Permission.ADMIN,
        avatar: '',
      })
    );
    await requested(asker, 50, MediaType.TV);
    await requested(asker, 60, MediaType.TV);
    await tracked(50, 'series', 50);
    await tracked(60, 'series', 60);
    await getRepository(AgentRun).save([
      new AgentRun({
        trigger: 'auto',
        status: 'running',
        kind: 'series',
        serverId: 0,
        arrId: 50,
        steps: [],
        actions: [],
      }),
      // Finished, or waiting for an answer: not looking.
      new AgentRun({
        trigger: 'auto',
        status: 'done',
        kind: 'series',
        serverId: 0,
        arrId: 60,
        steps: [],
        actions: [],
      }),
    ]);
    const agentOf = (rows: { tmdbId: number; agent: boolean }[]) =>
      Object.fromEntries(rows.map((r) => [r.tmdbId, r.agent]));

    actingAs = asker;
    assert.deepEqual(agentOf(await statusFor([50, 60])), {
      50: true,
      60: false,
    });
    actingAs = admin;
    assert.deepEqual(agentOf(await statusFor([50, 60])), {
      50: true,
      60: false,
    });
  });

  it('says nothing while Backfill is off', async () => {
    const asker = await user('asker2');
    await requested(asker, 40, MediaType.TV);
    await tracked(40, 'series', 5);
    getSettings().backfill = { ...getSettings().backfill, enabled: false };
    actingAs = asker;
    assert.deepEqual(await statusFor([40]), []);
  });
});
