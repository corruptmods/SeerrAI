import type BackfillSeries from '@server/entity/BackfillSeries';
import backfill from '@server/lib/backfill/engine';
import BackfillSonarr, { seasonOrNone } from '@server/lib/backfill/sonarr';
import type { SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

/*
 * Answers as Sonarr v5 does on its /api/v3 routes, shapes taken from its
 * source (v5.0.0.2569): a name with no season reads as season -1, packs list
 * every season they cover, and a series can carry a translated title with
 * the original beside it.
 */
let server: http.Server;
let settings: SonarrSettings;

const routes: Record<string, unknown> = {
  '/api/v3/parse': {
    title: '[Group] Frieren - 05 [1080p].mkv',
    parsedEpisodeInfo: {
      seriesTitle: 'Frieren',
      seasonNumber: -1,
      seasonNumbers: [],
      episodeNumbers: [],
      absoluteEpisodeNumbers: [5],
      fullSeason: false,
      isMultiSeason: false,
    },
  },
  '/api/v3/release': [
    { guid: 'a', title: 'Frieren - 05', indexerId: 1, seasonNumber: -1 },
    {
      guid: 'b',
      title: 'Frieren S01-S02',
      indexerId: 1,
      seasonNumber: 1,
      seasonNumbers: [1, 2],
      fullSeason: true,
    },
    { guid: 'c', title: 'Frieren S00E01', indexerId: 1, seasonNumber: 0 },
  ],
  '/api/v3/series/7': {
    id: 7,
    title: 'Frieren – Nach dem Ende der Reise',
    originalTitle: 'Sousou no Frieren',
    year: 2023,
    tvdbId: 424536,
    seriesType: 'anime',
    qualityProfileId: 1,
    path: '/tv/Frieren',
    alternateTitles: [{ title: 'Frieren: Beyond Journey’s End' }],
  },
  '/api/v3/series/8': {
    id: 8,
    title: 'Frieren – Nach dem Ende der Reise',
    originalTitle: '葬送のフリーレン',
    year: 2023,
    tvdbId: 424536,
    seriesType: 'anime',
    qualityProfileId: 1,
    path: '/tv/Frieren',
  },
  '/api/v3/episode': [],
  '/api/v3/episodefile': [],
  '/api/v3/qualityprofile/1': { id: 1, name: 'HD', items: [], cutoff: 1 },
};

before(async () => {
  server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    const body = routes[path];
    res.writeHead(body === undefined ? 404 : 200, {
      'Content-Type': 'application/json',
    });
    res.end(JSON.stringify(body ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  settings = {
    id: 0,
    name: 'Sonarr v5',
    hostname: '127.0.0.1',
    port: (server.address() as AddressInfo).port,
    apiKey: 'k',
    useSsl: false,
    baseUrl: '',
  } as SonarrSettings;
  getSettings().sonarr = [settings];
});

after(() => {
  getSettings().sonarr = [];
  server.close();
});

describe('Sonarr v5', () => {
  it('reads season -1 as no season, and keeps 0 for specials', () => {
    assert.equal(seasonOrNone(-1), undefined);
    assert.equal(seasonOrNone(undefined), undefined);
    assert.equal(seasonOrNone(0), 0);
    assert.equal(seasonOrNone(3), 3);
  });

  it('reads a name with no season as having none, as v4 did', async () => {
    const parsed = await BackfillSonarr.forServer(settings).parse(
      '[Group] Frieren - 05 [1080p].mkv'
    );
    assert.equal(parsed.parsedEpisodeInfo?.seasonNumber, undefined);
    assert.deepEqual(parsed.parsedEpisodeInfo?.absoluteEpisodeNumbers, [5]);
  });

  it('keeps the seasons a pack covers in search results', async () => {
    const releases = await BackfillSonarr.forServer(settings).getReleases({
      seriesId: 7,
      seasonNumber: 1,
    });
    assert.deepEqual(
      releases.map((r) => [r.guid, r.seasonNumber, r.seasonNumbers ?? null]),
      [
        ['a', undefined, null],
        ['b', 1, [1, 2]],
        ['c', 0, null],
      ]
    );
  });

  it('searches under the original title when the series is shown translated', async () => {
    const ctx = await backfill.context({
      serverId: 0,
      arrId: 7,
      searchTerms: [],
    } as unknown as BackfillSeries);
    assert.ok(ctx.names.includes('Sousou no Frieren'));
    assert.ok(ctx.names.includes('Frieren – Nach dem Ende der Reise'));

    // Not in a script release names use.
    const other = await backfill.context({
      serverId: 0,
      arrId: 8,
      searchTerms: [],
    } as unknown as BackfillSeries);
    assert.ok(!other.names.includes('葬送のフリーレン'));
  });
});
