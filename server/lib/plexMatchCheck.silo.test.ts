import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import type { SiloCatalogItem } from '@server/api/silo/types';
import { MediaServerType } from '@server/constants/server';
import { plexMatchText } from '@server/lib/health';
import plexMatchCheck, {
  REPORT_PATH,
  seriesFolderOf,
} from '@server/lib/plexMatchCheck';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import {
  createFakeSilo,
  siloEpisode,
  siloMovie,
  siloSeries,
} from '@server/test/fakeSilo';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import type { TestContext } from 'node:test';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

/*
 * Match Check on Silo: films by their files' folders, series by their
 * episodes' series folder, read with the optional admin:catalog:paths scope;
 * left out, with a note, without it.
 */

setupTestDb();

const silo = createFakeSilo();
before(() => silo.start());
after(() => silo.stop());

const withFile = (item: SiloCatalogItem, path: string): SiloCatalogItem => ({
  ...item,
  versions: item.versions.map((v) => ({ ...v, file_path: path })),
});

beforeEach(() => {
  silo.reset();
  silo.items = [
    // Right: Radarr has Glasswing there.
    withFile(
      siloMovie('film-glasswing', { tmdbId: 11, libraryId: 'mixed' }),
      '/data/movies/Glasswing (2026)/Glasswing.mkv'
    ),
    // Not matched at all.
    withFile(
      siloMovie('local-lantern', { title: 'Lantern Song', libraryId: 'mixed' }),
      '/data/movies/Lantern Song (2025)/Lantern.Song.mkv'
    ),
    // Matched to another series than Sonarr has in its folder.
    {
      ...siloSeries('series-harbour', { tvdbId: 2002, libraryId: 'mixed' }),
      title: 'Harbour Lights',
    },
    withFile(
      siloEpisode('series-harbour', 1, 1, { libraryId: 'mixed' }),
      '/data/tv/Static Garden/Season 01/Static.Garden.S01E01.mkv'
    ),
  ];
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.SILO;
  settings.plex.connected = false;
  settings.jellyfin.connected = false;
  settings.emby.connected = false;
  settings.silo = silo.settings({
    libraries: [
      { id: 'mixed', name: 'Everything', enabled: true, type: 'mixed' },
    ],
    optionalScopes: ['admin:catalog:paths'],
  });
  settings.sonarr = [
    { id: 0, name: 'Sonarr', hostname: 's', port: 1, apiKey: 'k' },
  ] as unknown as SonarrSettings[];
  settings.radarr = [
    { id: 0, name: 'Radarr', hostname: 'r', port: 1, apiKey: 'k' },
  ] as unknown as RadarrSettings[];
});

afterEach(async () => {
  await fs.rm(REPORT_PATH, { force: true });
  const settings = getSettings();
  settings.sonarr = [];
  settings.radarr = [];
  settings.main.mediaServerType = MediaServerType.NOT_CONFIGURED;
  settings.silo.connected = false;
});

/** What Sonarr and Radarr have; their clients set these per instance. */
const arrsHave = (t: TestContext) => {
  t.mock.method(SonarrAPI.prototype, 'getSeries', async () => [
    {
      title: 'Static Garden',
      year: 2024,
      tvdbId: 1001,
      path: '/tv/Static Garden',
    },
  ]);
  Object.defineProperty(RadarrAPI.prototype, 'getMovies', {
    configurable: true,
    set() {
      // Swallow the constructor's own assignment.
    },
    get() {
      return async () => [
        {
          title: 'Glasswing',
          year: 2026,
          tmdbId: 11,
          path: '/movies/Glasswing (2026)',
        },
        {
          title: 'Lantern Song',
          year: 2025,
          tmdbId: 12,
          path: '/movies/Lantern Song (2025)',
        },
      ];
    },
  });
  t.after(() => {
    delete (RadarrAPI.prototype as unknown as Record<string, unknown>)
      .getMovies;
  });
};

describe('Match Check on Silo', () => {
  it('finds a series by its episodes’ folder, above a season folder', () => {
    assert.equal(
      seriesFolderOf('/data/tv/Static Garden/Season 01/e.mkv'),
      'Static Garden'
    );
    assert.equal(
      seriesFolderOf('D:\\TV\\Harbour Lights\\S02\\e.mkv'),
      'Harbour Lights'
    );
    assert.equal(seriesFolderOf('/tv/Glasswing/e.mkv'), 'Glasswing');
  });

  it('checks films and series by their folders, with Silo’s wording', async (t) => {
    arrsHave(t);
    await plexMatchCheck.run();
    const report = await plexMatchCheck.lastReport();
    assert.equal(report.error, undefined);
    assert.equal(report.checked, 3);
    const found = report.problems
      .map((p) => [p.mediaServer, p.reason, p.matched.key])
      .sort();
    assert.deepEqual(found, [
      ['Silo', 'other', 'series-harbour'],
      ['Silo', 'unmatched', 'local-lantern'],
    ]);
    const series = report.problems.find((p) => p.kind === 'series');
    assert.ok(series);
    assert.match(
      plexMatchText(series).detail,
      /Match Item in Silo, entering TVDB id 1001/
    );
  });

  it('leaves Silo out, saying why, without the scope', async (t) => {
    arrsHave(t);
    getSettings().silo.optionalScopes = [];
    await plexMatchCheck.run();
    const report = await plexMatchCheck.lastReport();
    assert.equal(report.checked, 0);
    assert.equal(report.error, undefined);
    assert.match(report.notes?.[0] ?? '', /admin:catalog:paths/);
    assert.ok(
      !silo.calls.some((call) => call.query.include_file_paths === 'true')
    );
  });
});
