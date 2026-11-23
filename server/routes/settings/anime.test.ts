import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import {
  animeAutoReasons,
  animeLibraryReasons,
  animeLibrarySetUp,
  animeSwitchedOn,
  getSettings,
  setAnimeRulesSetUp,
} from '@server/lib/settings';
import migrateAnimeExcludedCountries from '@server/lib/settings/migrations/0011_anime_excluded_countries';
import settingsRoutes from '@server/routes/settings';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import request from 'supertest';

/*
 * Settings → Services → Anime: whether anime handling is on (auto, on, off),
 * whether Anime Check runs, and "Leave out anime made in": countries whose
 * anime counts as anime only when it is in Japanese.
 */

const app = express();
app.use(express.json());
app.use(
  OpenApiValidator.middleware({
    apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
    validateRequests: true,
    validateSecurity: false,
  })
);
app.use('/api/v1/settings', settingsRoutes);
app.use(
  (
    err: { status?: number; message: string },
    _req: express.Request,
    res: express.Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _next: express.NextFunction
  ) => {
    res.status(err.status ?? 500).json({ message: err.message });
  }
);

beforeEach(() => {
  const settings = getSettings();
  settings.main.animeExcludedCountries = [];
  settings.main.anime = 'auto';
  settings.main.animeCheck = true;
  settings.sonarr = [];
  settings.radarr = [];
  setAnimeRulesSetUp(false);
});

/** What GET /settings/anime says on a new server, with `changes`. */
const view = (changes: Record<string, unknown> = {}) => ({
  mode: 'auto',
  enabled: false,
  librarySetUp: false,
  autoReasons: [],
  check: true,
  excludedCountries: [],
  ...changes,
});

const sonarr = (fields: Partial<SonarrSettings> = {}) =>
  ({
    id: 0,
    name: 'Harbour Lights Sonarr',
    activeDirectory: '/tv',
    activeProfileId: 1,
    tags: [],
    seriesType: 'standard',
    animeSeriesType: 'anime',
    ...fields,
  }) as SonarrSettings;

const radarr = (fields: Partial<RadarrSettings> = {}) =>
  ({
    id: 0,
    name: 'Glasswing Radarr',
    activeDirectory: '/movies',
    activeProfileId: 1,
    tags: [],
    ...fields,
  }) as RadarrSettings;

describe('the anime settings', () => {
  it('start empty on a new server, and say so in the public settings', async () => {
    const res = await request(app).get('/api/v1/settings/anime');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, view());
    assert.deepEqual(
      getSettings().fullPublicSettings.animeExcludedCountries,
      []
    );
  });

  it('replace the whole list, tidied', async () => {
    getSettings().main.animeExcludedCountries = ['US', 'KR'];
    const res = await request(app)
      .post('/api/v1/settings/anime')
      .send({ excludedCountries: ['cn', 'US', 'CN'] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, view({ excludedCountries: ['CN', 'US'] }));
    assert.deepEqual(getSettings().main.animeExcludedCountries, ['CN', 'US']);
    assert.deepEqual(getSettings().fullPublicSettings.animeExcludedCountries, [
      'CN',
      'US',
    ]);

    const emptied = await request(app)
      .post('/api/v1/settings/anime')
      .send({ excludedCountries: [] });
    assert.deepEqual(emptied.body, view());
    assert.deepEqual(getSettings().main.animeExcludedCountries, []);
  });

  it('refuse anything that is not a list of country codes, a mode or a switch', async () => {
    getSettings().main.animeExcludedCountries = ['US'];
    for (const body of [
      {},
      { excludedCountries: 'US' },
      { excludedCountries: ['USA'] },
      { excludedCountries: ['U1'] },
      { mode: 'sometimes' },
      { check: 'yes' },
    ]) {
      const res = await request(app).post('/api/v1/settings/anime').send(body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.deepEqual(getSettings().main.animeExcludedCountries, ['US']);
    assert.equal(getSettings().main.anime, 'auto');
    assert.equal(getSettings().main.animeCheck, true);
  });

  it('turn anime and Anime Check on or off, changing only what is sent', async () => {
    getSettings().main.animeExcludedCountries = ['US'];
    const on = await request(app)
      .post('/api/v1/settings/anime')
      .send({ mode: 'on', check: false });
    assert.equal(on.status, 200);
    assert.deepEqual(
      on.body,
      view({
        mode: 'on',
        enabled: true,
        check: false,
        excludedCountries: ['US'],
      })
    );
    assert.equal(getSettings().fullPublicSettings.animeEnabled, true);

    const off = await request(app)
      .post('/api/v1/settings/anime')
      .send({ mode: 'off' });
    assert.deepEqual(
      off.body,
      view({ mode: 'off', check: false, excludedCountries: ['US'] })
    );
    assert.equal(getSettings().fullPublicSettings.animeEnabled, false);
  });

  it('are on in auto once a server has an anime library, and say so publicly', async () => {
    getSettings().sonarr = [sonarr({ activeAnimeDirectory: '/anime' })];
    const res = await request(app).get('/api/v1/settings/anime');
    assert.deepEqual(
      res.body,
      view({ enabled: true, librarySetUp: true, autoReasons: ['folder'] })
    );
    assert.equal(getSettings().fullPublicSettings.animeEnabled, true);

    getSettings().main.anime = 'off';
    assert.equal(getSettings().fullPublicSettings.animeEnabled, false);
  });

  it('are on in auto for an override rule that routes anime, and say so', async () => {
    setAnimeRulesSetUp(true);
    const res = await request(app).get('/api/v1/settings/anime');
    assert.deepEqual(res.body, view({ enabled: true, autoReasons: ['rule'] }));
    assert.equal(getSettings().fullPublicSettings.animeEnabled, true);

    // Off still wins, and the reasons still say what auto would see.
    getSettings().main.anime = 'off';
    const off = await request(app).get('/api/v1/settings/anime');
    assert.deepEqual(off.body, view({ mode: 'off', autoReasons: ['rule'] }));
  });

  it('take back what a GET returned, with its fields that only say how things are', async () => {
    getSettings().sonarr = [sonarr({ activeAnimeDirectory: '/anime' })];
    setAnimeRulesSetUp(true);
    const got = await request(app).get('/api/v1/settings/anime');
    assert.equal(got.status, 200);

    const res = await request(app)
      .post('/api/v1/settings/anime')
      .send({
        ...got.body,
        mode: 'off',
        excludedCountries: ['us'],
        // Ignored: these only say how things are.
        enabled: true,
        librarySetUp: false,
        autoReasons: [],
      });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(
      res.body,
      view({
        mode: 'off',
        librarySetUp: true,
        autoReasons: ['folder', 'rule'],
        excludedCountries: ['US'],
      })
    );
    assert.equal(getSettings().main.anime, 'off');
  });
});

const animeLibraryReasonsFor = (
  sonarrServers: SonarrSettings[],
  radarrServers: RadarrSettings[] = []
) => animeLibraryReasons(sonarrServers, radarrServers);

describe('auto: whether an anime library is set up', () => {
  it('is not, with no servers or only standard settings', () => {
    assert.equal(animeLibrarySetUp([], []), false);
    assert.equal(animeLibrarySetUp([sonarr()], [radarr()]), false);
  });

  it("doesn't count Sonarr's anime series type, which every server has", () => {
    assert.equal(
      animeLibrarySetUp([sonarr({ animeSeriesType: 'anime' })], []),
      false
    );
  });

  it("doesn't count anime settings that are the standard ones again", () => {
    assert.equal(
      animeLibrarySetUp(
        [
          sonarr({
            activeAnimeDirectory: '/tv',
            activeAnimeProfileId: 1,
            activeLanguageProfileId: 2,
            activeAnimeLanguageProfileId: 2,
            tags: [3, 4],
            animeTags: [4, 3],
          }),
        ],
        []
      ),
      false
    );
  });

  it('is, with an anime folder, profile or tags of its own on any server', () => {
    assert.deepEqual(
      animeLibraryReasonsFor([sonarr({ activeAnimeDirectory: '/anime' })]),
      ['folder']
    );
    assert.deepEqual(
      animeLibraryReasonsFor(
        [],
        [radarr(), radarr({ activeAnimeProfileId: 7 })]
      ),
      ['profile']
    );
    assert.deepEqual(animeLibraryReasonsFor([], [radarr({ animeTags: [9] })]), [
      'tags',
    ]);
  });

  it("counts a Sonarr's standard tags with no anime tags, which anime goes without", () => {
    // Sonarr sends anime with its anime tags, even none.
    assert.deepEqual(
      animeLibraryReasonsFor([sonarr({ tags: [5], animeTags: [] })]),
      ['tags']
    );
    assert.deepEqual(animeLibraryReasonsFor([sonarr({ tags: [5] })]), ['tags']);
    // Radarr sends anime with its standard tags when it has no anime tags.
    assert.deepEqual(
      animeLibraryReasonsFor([], [radarr({ tags: [5], animeTags: [] })]),
      []
    );
  });

  it('counts a Sonarr v3 anime language profile other than its standard one', () => {
    assert.deepEqual(
      animeLibraryReasonsFor([
        sonarr({ activeLanguageProfileId: 1, activeAnimeLanguageProfileId: 3 }),
      ]),
      ['languageProfile']
    );
  });

  it('names each reason once, whichever servers have it', () => {
    assert.deepEqual(
      animeLibraryReasonsFor(
        [sonarr({ activeAnimeDirectory: '/anime', animeTags: [2] })],
        [radarr({ activeAnimeDirectory: '/anime-movies' })]
      ),
      ['folder', 'tags']
    );
  });
});

describe('auto: override rules that route anime', () => {
  it('turn anime on with no anime library anywhere, and are named', () => {
    assert.equal(animeSwitchedOn('auto', [sonarr()], [radarr()], true), true);
    assert.deepEqual(animeAutoReasons([sonarr()], [radarr()], true), ['rule']);
    assert.equal(animeSwitchedOn('auto', [sonarr()], [radarr()], false), false);
    assert.equal(animeSwitchedOn('off', [], [], true), false);
  });
});

describe('the upgrade to the setting', () => {
  it('keeps the old rule on a server from before it: American anime is left out', () => {
    const migrated = migrateAnimeExcludedCountries({
      main: { applicationTitle: 'Seerr AI' },
      migrations: ['0009_maintainerr_servers'],
    });
    assert.deepEqual(migrated.main.animeExcludedCountries, ['US']);
    assert.deepEqual(migrated.migrations, [
      '0009_maintainerr_servers',
      '0011_anime_excluded_countries',
    ]);
  });

  it('leaves a new server, which already has the setting, as it is', () => {
    const migrated = migrateAnimeExcludedCountries({
      main: { animeExcludedCountries: [] },
    });
    assert.deepEqual(migrated.main.animeExcludedCountries, []);
  });

  it('runs once: an admin who empties the list keeps it empty', () => {
    const once = migrateAnimeExcludedCountries({ main: {} });
    once.main.animeExcludedCountries = [];
    delete (once.main as { animeExcludedCountries?: string[] })
      .animeExcludedCountries;
    const twice = migrateAnimeExcludedCountries(once);
    assert.equal(twice.main.animeExcludedCountries, undefined);
  });
});
