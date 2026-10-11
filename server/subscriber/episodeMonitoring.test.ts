import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import EpisodeRequest from '@server/entity/EpisodeRequest';
import Media from '@server/entity/Media';
import MediaEvent from '@server/entity/MediaEvent';
import { MediaRequest } from '@server/entity/MediaRequest';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { applySeasonMonitoring } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

/*
 * Episode-level monitoring: a request for two episodes should leave Sonarr
 * monitoring exactly those, and removing it should stop monitoring what
 * nobody wants any more. Against a fake Sonarr that records what it is told,
 * and can be made to fail.
 */

setupTestDb();

Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
  configurable: true,
  set() {},
  get() {
    return async ({ tvId }: { tvId: number }) => ({
      id: tvId,
      name: 'Show',
      seasons: [],
      external_ids: {},
      keywords: { results: [] },
    });
  },
});

const SERIES = 77;
let failing = false;
let monitorCalls: { episodeIds: number[]; monitored: boolean }[] = [];
let commands: { name: string; episodeIds?: number[] }[] = [];
let episodeFetches = 0;
// Season 1 of the series, as Sonarr reports it.
const episodes = () => [
  {
    id: 101,
    seasonNumber: 1,
    episodeNumber: 1,
    monitored: true,
    hasFile: false,
    airDateUtc: '2020-01-01T00:00:00Z',
  },
  {
    id: 102,
    seasonNumber: 1,
    episodeNumber: 2,
    monitored: true,
    hasFile: false,
    airDateUtc: '2020-01-08T00:00:00Z',
  },
  {
    id: 103,
    seasonNumber: 1,
    episodeNumber: 3,
    monitored: true,
    hasFile: true,
    airDateUtc: '2020-01-15T00:00:00Z',
  },
];

const fake = http.createServer((req, res) => {
  const url = req.url ?? '';
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (failing) {
      res.writeHead(500);
      res.end('Sonarr is having a bad day');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.startsWith('/api/v3/episode/monitor')) {
      monitorCalls.push(JSON.parse(raw));
      res.end('[]');
    } else if (url.startsWith('/api/v3/episode')) {
      episodeFetches++;
      res.end(JSON.stringify(episodes()));
    } else if (url.startsWith('/api/v3/command')) {
      commands.push(JSON.parse(raw));
      res.end('{"id":1}');
    } else {
      res.end('{}');
    }
  });
});
let port: number;

before(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
  port = (fake.address() as { port: number }).port;
});
after(() => fake.close());

let user: User;
let media: Media;

beforeEach(async () => {
  failing = false;
  monitorCalls = [];
  commands = [];
  episodeFetches = 0;
  getSettings().sonarr = [
    {
      id: 0,
      name: 'Sonarr',
      hostname: '127.0.0.1',
      port,
      apiKey: 'k',
      useSsl: false,
      baseUrl: '',
      activeProfileId: 1,
      activeProfileName: 'Any',
      activeDirectory: '/tv',
      activeLanguageProfileId: 1,
      is4k: false,
      isDefault: true,
      enableSeasonFolders: true,
      syncEnabled: false,
      preventSearch: false,
      tagRequests: false,
      tags: [],
      animeTags: [],
      overrideRule: [],
    } as never,
  ];
  user = await getRepository(User).save(
    new User({
      email: 'mon@test.local',
      plexUsername: 'mon',
      permissions: Permission.REQUEST,
      avatar: '',
    })
  );
  media = await getRepository(Media).save(
    new Media({
      tmdbId: 7001,
      mediaType: MediaType.TV,
      status: MediaStatus.PROCESSING,
      serviceId: 0,
      externalServiceId: SERIES,
    })
  );
});

const sonarr = () =>
  new SonarrAPI({ apiKey: 'k', url: `http://127.0.0.1:${port}/api/v3` });

// A pending request for season 1, episodes as given. Pending, so saving it
// does not try to send it anywhere.
const request = (episodeNumbers: number[]) =>
  new MediaRequest({
    type: MediaType.TV,
    media,
    requestedBy: user,
    status: MediaRequestStatus.PENDING,
    is4k: false,
    serverId: 0,
    seasons: [
      new SeasonRequest({
        seasonNumber: 1,
        status: MediaRequestStatus.PENDING,
        episodes: episodeNumbers.map(
          (episodeNumber) => new EpisodeRequest({ episodeNumber })
        ),
      }),
    ],
  });

const loaded = (id: number) =>
  getRepository(MediaRequest).findOneOrFail({
    where: { id },
    relations: { media: true, seasons: { episodes: true } },
  });

const events = () =>
  getRepository(MediaEvent).find({
    where: { tmdbId: 7001, type: 'monitoring_failed' as never },
  });

describe('applying a request for some episodes', () => {
  it('monitors exactly the requested episodes and searches for them', async () => {
    const saved = await getRepository(MediaRequest).save(request([2]));
    await applySeasonMonitoring(sonarr(), SERIES, await loaded(saved.id));
    assert.deepEqual(
      monitorCalls,
      [{ episodeIds: [101, 103], monitored: false }],
      'the others unmonitored; 102 already monitored'
    );
    assert.deepEqual(commands, [{ name: 'EpisodeSearch', episodeIds: [102] }]);
  });

  it('records a failure on the title rather than only in the log', async () => {
    const saved = await getRepository(MediaRequest).save(request([2]));
    failing = true;
    await applySeasonMonitoring(sonarr(), SERIES, await loaded(saved.id));
    const [event] = await events();
    assert.ok(event, 'a monitoring_failed event');
    assert.match(
      event.detail!,
      /^Sonarr was not limited to the requested episodes: /
    );
  });
});

describe('removing a request', () => {
  it('stops monitoring the episodes nobody wants any more', async () => {
    const saved = await getRepository(MediaRequest).save(request([2]));
    const withRelations = await loaded(saved.id);
    await getRepository(MediaRequest).remove(withRelations);
    assert.ok(episodeFetches > 0, 'the clean-up asked Sonarr');
    assert.deepEqual(
      monitorCalls,
      [{ episodeIds: [101, 102, 103], monitored: false }],
      'no live request wants any of them now'
    );
  });

  it('cleans up for a request created and removed in one transaction', async () => {
    await dataSource.transaction(async (manager) => {
      const saved = await manager
        .getRepository(MediaRequest)
        .save(request([2]));
      const withRelations = await manager
        .getRepository(MediaRequest)
        .findOneOrFail({
          where: { id: saved.id },
          relations: { media: true, seasons: { episodes: true } },
        });
      await manager.getRepository(MediaRequest).remove(withRelations);
    });
    assert.ok(
      episodeFetches > 0,
      'the clean-up found the request and asked Sonarr'
    );
  });

  it('records a clean-up failure on the title', async () => {
    const saved = await getRepository(MediaRequest).save(request([2]));
    const withRelations = await loaded(saved.id);
    failing = true;
    await getRepository(MediaRequest).remove(withRelations);
    const [event] = await events();
    assert.ok(event, 'a monitoring_failed event');
    assert.match(
      event.detail!,
      /^Sonarr still monitors episodes no longer requested: /
    );
  });
});
