import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
import calendarRoutes from '@server/routes/calendar';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import http from 'node:http';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

/*
 * The release calendar, against fake Radarr and Sonarr calendars, behind the
 * real API validator.
 */

setupTestDb();

const DAY = 24 * 60 * 60 * 1000;
// Film dates are calendar dates at midnight UTC, as Radarr gives them.
const utcDay = (days: number) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
};
const at = (days: number, hour: number) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

let radarr: unknown[] = [];
let radarr4k: unknown[] = [];
let sonarr: unknown[] = [];
let asked: string[] = [];
const fake = http.createServer((req, res) => {
  const url = req.url ?? '';
  asked.push(
    url.split('?')[0] +
      (url.includes('includeSeries=true') ? '?includeSeries' : '')
  );
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (url.startsWith('/radarr4k/api/v3/calendar'))
    return res.end(JSON.stringify(radarr4k));
  if (url.startsWith('/radarr/api/v3/calendar'))
    return res.end(JSON.stringify(radarr));
  if (url.startsWith('/sonarr/api/v3/calendar'))
    return res.end(JSON.stringify(sonarr));
  res.end('[]');
});
let fakePort: number;
let app: Server;
let port: number;

before(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
  fakePort = (fake.address() as { port: number }).port;
  const ex = express();
  ex.use(express.json());
  ex.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateSecurity: false,
    })
  );
  ex.use('/api/v1/calendar', calendarRoutes);
  app = await new Promise<Server>((resolve) => {
    const s = ex.listen(0, () => resolve(s));
  });
  port = (app.address() as { port: number }).port;
});
after(() => {
  app?.close();
  fake.close();
});

const server = (
  id: number,
  name: string,
  baseUrl: string,
  is4k = false,
  p = 0
) =>
  ({
    id,
    name,
    hostname: '127.0.0.1',
    port: p || fakePort,
    apiKey: 'k',
    useSsl: false,
    baseUrl,
    is4k,
    isDefault: !is4k,
  }) as never;

beforeEach(async () => {
  asked = [];
  radarr = [];
  radarr4k = [];
  sonarr = [];
  getSettings().radarr = [
    server(0, 'Radarr', '/radarr'),
    server(1, 'Radarr 4K', '/radarr4k', true),
  ];
  getSettings().sonarr = [server(0, 'Sonarr', '/sonarr')];
  await getRepository(User).find();
});

type Item = {
  mediaType: string;
  tmdbId?: number;
  title: string;
  poster?: string;
  at: string;
  allDay: boolean;
  kind: string;
  season?: number;
  episodes?: number[];
  episodeTitle?: string;
  available: boolean;
};
const calendar = (query = '') =>
  new Promise<{ status: number; body: { items: Item[] } }>(
    (resolve, reject) => {
      http
        .get(
          { host: '127.0.0.1', port, path: `/api/v1/calendar${query}` },
          (res) => {
            let raw = '';
            res.on('data', (c) => (raw += c));
            res.on('end', () => {
              let body = { items: [] as Item[] };
              try {
                body = JSON.parse(raw);
              } catch {
                // An error page: the status is what matters.
              }
              resolve({ status: res.statusCode ?? 0, body });
            });
          }
        )
        .on('error', reject);
    }
  );

// The server caches a calendar for ten minutes per range, so each test asks
// for a range of its own.
describe('the release calendar', () => {
  it('lists each release a film has in range, once, even with a 4K server', async () => {
    const film = {
      tmdbId: 1291595,
      title: 'Insidious: Out of the Further',
      hasFile: false,
      inCinemas: utcDay(-40),
      digitalRelease: utcDay(12),
      physicalRelease: utcDay(30),
      images: [
        {
          coverType: 'poster',
          remoteUrl: 'https://image.tmdb.org/t/p/original/x.jpg',
        },
      ],
    };
    radarr = [film];
    radarr4k = [film];
    const { status, body } = await calendar('?weeks=5');
    assert.equal(status, 200);
    assert.deepEqual(
      body.items.map((i) => [i.title, i.kind, i.at, i.allDay, i.poster]),
      [
        [
          'Insidious: Out of the Further',
          'digital',
          utcDay(12),
          true,
          'https://image.tmdb.org/t/p/original/x.jpg',
        ],
        [
          'Insidious: Out of the Further',
          'physical',
          utcDay(30),
          true,
          'https://image.tmdb.org/t/p/original/x.jpg',
        ],
      ],
      'the cinema date is past the range; each date once across both servers'
    );
    assert.ok(
      asked.includes('/radarr/api/v3/calendar') &&
        asked.includes('/sonarr/api/v3/calendar?includeSeries')
    );
  });

  it('reads episodes airing together as one line, and apart as two', async () => {
    const show = {
      title: 'Neagley',
      tvdbId: 400,
      tmdbId: 250307,
      images: [
        {
          coverType: 'poster',
          remoteUrl: 'https://artworks.thetvdb.com/p.jpg',
        },
      ],
    };
    sonarr = [
      {
        seriesId: 7,
        seasonNumber: 1,
        episodeNumber: 1,
        title: 'Pilot',
        airDateUtc: at(3, 1),
        hasFile: false,
        monitored: true,
        series: show,
      },
      {
        seriesId: 7,
        seasonNumber: 1,
        episodeNumber: 2,
        title: 'Two',
        airDateUtc: at(3, 1),
        hasFile: false,
        monitored: true,
        series: show,
      },
      {
        seriesId: 7,
        seasonNumber: 1,
        episodeNumber: 3,
        title: 'Three',
        airDateUtc: at(10, 1),
        hasFile: false,
        monitored: true,
        series: show,
      },
    ];
    const { body } = await calendar('?weeks=2');
    assert.deepEqual(
      body.items.map((i) => [
        i.title,
        i.tmdbId,
        i.season,
        i.episodes,
        i.episodeTitle ?? null,
        i.allDay,
        i.at,
      ]),
      [
        ['Neagley', 250307, 1, [1, 2], null, false, at(3, 1)],
        ['Neagley', 250307, 1, [3], 'Three', false, at(10, 1)],
      ]
    );
  });

  it("finds a series' TMDB id from its TVDB id when Sonarr leaves it out", async () => {
    await getRepository(Media).save(
      new Media({
        tmdbId: 1399,
        tvdbId: 121361,
        mediaType: MediaType.TV,
        status: MediaStatus.PROCESSING,
      })
    );
    sonarr = [
      {
        seriesId: 1,
        seasonNumber: 8,
        episodeNumber: 1,
        airDateUtc: at(2, 1),
        hasFile: false,
        monitored: true,
        series: { title: 'Older Sonarr', tvdbId: 121361 },
      },
    ];
    const { body } = await calendar('?weeks=3');
    assert.equal(body.items[0].tmdbId, 1399);
  });

  it('still shows one server when another is down', async () => {
    getSettings().radarr = [server(0, 'Radarr', '/radarr', false, 1)];
    sonarr = [
      {
        seriesId: 1,
        seasonNumber: 1,
        episodeNumber: 1,
        airDateUtc: at(2, 1),
        hasFile: true,
        monitored: true,
        series: { title: 'Up', tvdbId: 1, tmdbId: 5 },
      },
    ];
    const { status, body } = await calendar('?weeks=6');
    assert.equal(status, 200);
    assert.deepEqual(
      body.items.map((i) => [i.title, i.available]),
      [['Up', true]]
    );
  });

  it('covers the weeks asked for, and no more', async () => {
    radarr = [
      { tmdbId: 1, title: 'Soon', hasFile: false, digitalRelease: utcDay(20) },
      { tmdbId: 2, title: 'Later', hasFile: false, digitalRelease: utcDay(50) },
    ];
    assert.deepEqual(
      (await calendar('?weeks=4')).body.items.map((i) => i.title),
      ['Soon']
    );
    assert.deepEqual(
      (await calendar('?weeks=8')).body.items.map((i) => i.title),
      ['Soon', 'Later']
    );
    assert.equal(
      (await calendar('?weeks=99')).status,
      400,
      'the spec caps it at 12'
    );
  });
});
