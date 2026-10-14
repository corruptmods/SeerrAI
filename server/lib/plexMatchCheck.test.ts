import JellyfinAPI from '@server/api/jellyfin';
import type { PlexLibraryItem } from '@server/api/plexapi';
import PlexAPI from '@server/api/plexapi';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaServerType } from '@server/constants/server';
import { plexMatchText } from '@server/lib/health';
import type { PlexMatchProblem } from '@server/lib/plexMatchCheck';
import plexMatchCheck, {
  REPORT_PATH,
  compareItem,
  folderName,
  plexIds,
} from '@server/lib/plexMatchCheck';
import type { SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { describe, it } from 'node:test';

/*
 * Plex matched the folder "Carrie" (Sonarr: Carrie, 2026) to The Carrie
 * Diaries, and nothing said so. The check finds folders whose Plex match
 * disagrees with what Sonarr or Radarr has in them.
 */

setupTestDb();

const show = (
  ratingKey: string,
  title: string,
  folder: string,
  guids: string[],
  guid = 'plex://show/x'
): PlexLibraryItem =>
  ({
    ratingKey,
    title,
    guid,
    type: 'show',
    Guid: guids.map((id) => ({ id })),
    Location: [{ path: `/data/tv/${folder}` }],
    Media: [],
  }) as unknown as PlexLibraryItem;

const movie = (
  ratingKey: string,
  title: string,
  file: string,
  guids: string[]
): PlexLibraryItem =>
  ({
    ratingKey,
    title,
    guid: 'plex://movie/x',
    type: 'movie',
    Guid: guids.map((id) => ({ id })),
    Media: [{ Part: [{ file }] }],
  }) as unknown as PlexLibraryItem;

const carrie = {
  title: 'Carrie',
  year: 2026,
  tvdbId: 455755,
  tmdbId: 288673,
  server: 'Sonarr',
};

describe('Plex Match Check, one item at a time', () => {
  it('reads folder names however the slashes lean', () => {
    assert.equal(folderName('/tv/Carrie/'), 'Carrie');
    assert.equal(folderName('D:\\TV\\Carrie'), 'Carrie');
  });

  it('reads ids from new agents and legacy ones', () => {
    assert.deepEqual(
      plexIds(
        show('1', 'x', 'x', [
          'tvdb://257454',
          'tmdb://46157',
          'imdb://tt2056366',
        ])
      ),
      { tvdbId: 257454, tmdbId: 46157, imdbId: 'tt2056366' }
    );
    assert.deepEqual(
      plexIds(
        show('1', 'x', 'x', [], 'com.plexapp.agents.thetvdb://455755?lang=en')
      ),
      { tvdbId: 455755 }
    );
  });

  it('flags a folder Plex matched to another series', () => {
    const byFolder = new Map([['carrie', [carrie]]]);
    const { checked, problem } = compareItem(
      'series',
      show('126741', 'The Carrie Diaries', 'Carrie', [
        'tvdb://257454',
        'tmdb://46157',
      ]),
      byFolder
    );
    assert.equal(checked, true);
    assert.equal(problem?.reason, 'other');
    assert.equal(problem?.folder, 'Carrie');
    assert.equal(problem?.matched.key, '126741');
    assert.equal(problem?.expected.tvdbId, 455755);
  });

  it('leaves alone a folder Plex matched rightly, and one Sonarr does not have', () => {
    const byFolder = new Map([['carrie', [carrie]]]);
    assert.deepEqual(
      compareItem(
        'series',
        show('1', 'Carrie', 'Carrie', ['tvdb://455755']),
        byFolder
      ),
      { checked: true }
    );
    assert.deepEqual(
      compareItem(
        'series',
        show('2', 'Elsewhere', 'Elsewhere', ['tvdb://1']),
        byFolder
      ),
      { checked: false }
    );
  });

  it('flags a folder Plex has not matched at all', () => {
    const { problem } = compareItem(
      'series',
      show('3', 'Carrie', 'Carrie', [], 'local://3'),
      new Map([['carrie', [carrie]]])
    );
    assert.equal(problem?.reason, 'unmatched');
  });

  it('finds a movie by the folder its file is in', () => {
    const byFolder = new Map([
      [
        'adopted (2026)',
        [{ title: 'Adopted', year: 2026, tmdbId: 1393143, server: 'Radarr' }],
      ],
    ]);
    const { problem } = compareItem(
      'movie',
      movie('9', 'Adopted', '/movies/Adopted (2026)/Adopted.mkv', [
        'tmdb://555',
      ]),
      byFolder
    );
    assert.equal(problem?.reason, 'other');
    assert.equal(
      compareItem(
        'movie',
        movie('9', 'Adopted', '/movies/Adopted (2026)/Adopted.mkv', [
          'tmdb://1393143',
        ]),
        byFolder
      ).problem,
      undefined
    );
  });
});

describe('Plex Match Check, two titles with one name', () => {
  // Folders that read "Plex matched Americana (2025) to Americana (2025)":
  // the names agree and the ids don't, so the ids are what must be shown.
  const americana = {
    title: 'Americana',
    year: 2025,
    tmdbId: 1000,
    imdbId: 'tt1000',
    server: 'radarr',
  };
  const byFolder = new Map([['americana (2025)', [americana]]]);
  const plexAmericana = (ids: string[]) => ({
    ...movie('7', 'Americana', '/m/Americana (2025)/a.mkv', ids),
    year: 2025,
  });

  it('calls a same-named film with other ids another film, and shows both ids', () => {
    const { problem } = compareItem(
      'movie',
      plexAmericana(['tmdb://2000', 'imdb://tt2000']),
      byFolder
    );
    assert.equal(problem?.reason, 'other');
    const text = plexMatchText(problem as PlexMatchProblem);
    assert.equal(
      text.title,
      'Plex matched "Americana (2025)" to a different film named Americana (2025)'
    );
    assert.match(text.detail, /radarr: TMDB 1000, Plex: TMDB 2000/);
    assert.match(text.detail, /Fix Match in Plex, searching tmdb-1000/);
  });

  it('tells apart the same film under another TMDB entry', () => {
    const { problem } = compareItem(
      'movie',
      plexAmericana(['tmdb://2000', 'imdb://tt1000']),
      byFolder
    );
    assert.equal(problem?.reason, 'differentId');
    const text = plexMatchText(problem as PlexMatchProblem);
    assert.equal(
      text.title,
      'Plex and radarr use different entries for Americana (2025)'
    );
    assert.match(text.detail, /The same title by IMDb \(tt1000\)/);
    assert.match(text.detail, /radarr: TMDB 1000, Plex: TMDB 2000/);
  });

  it('still names a differently named match plainly', () => {
    const { problem } = compareItem(
      'movie',
      {
        ...movie('8', 'Guerra Civil', '/m/Civil War (2024)/c.mkv', [
          'tmdb://3',
        ]),
        year: 2024,
      },
      new Map([
        [
          'civil war (2024)',
          [
            {
              title: 'Civil War',
              year: 2024,
              tmdbId: 929590,
              server: 'radarr',
            },
          ],
        ],
      ])
    );
    assert.equal(
      plexMatchText(problem as PlexMatchProblem).title,
      'Plex matched "Civil War (2024)" to Guerra Civil (2024)'
    );
  });
});

describe('Plex Match Check, the whole library', () => {
  it('reads every page of each library and keeps what it found', async (t) => {
    t.after(() => fs.rm(REPORT_PATH, { force: true }));
    const settings = getSettings();
    settings.main.mediaServerType = MediaServerType.PLEX;
    settings.plex.libraries = [
      { id: '1', name: 'TV Shows', enabled: true, type: 'show' },
      { id: '2', name: 'Movies', enabled: true, type: 'movie' },
      { id: '3', name: 'Off', enabled: false, type: 'show' },
    ];
    settings.sonarr = [
      { id: 0, name: 'Sonarr', hostname: 's', port: 1, apiKey: 'k' },
    ] as unknown as SonarrSettings[];
    settings.radarr = [];
    t.mock.method(SonarrAPI.prototype, 'getSeries', async () => [
      { ...carrie, path: '/tv/Carrie' },
      { title: 'Bluey', year: 2018, tvdbId: 353546, path: '/tv/Bluey' },
    ]);
    const shows = [
      show('126741', 'The Carrie Diaries', 'Carrie', ['tvdb://257454']),
      ...Array.from({ length: 250 }, (_, i) =>
        show(`b${i}`, 'Bluey', 'Bluey', ['tvdb://353546'])
      ),
    ];
    const asked: string[] = [];
    t.mock.method(
      PlexAPI.prototype,
      'getLibraryContents',
      async (id: string, { offset = 0, size = 50 } = {}) => {
        asked.push(`${id}@${offset}`);
        const all = id === '1' ? shows : [];
        return {
          totalSize: all.length,
          items: all.slice(offset, offset + size),
        };
      }
    );

    await plexMatchCheck.run();
    const report = await plexMatchCheck.lastReport();
    assert.equal(report.error, undefined);
    assert.deepEqual(asked, ['1@0', '1@200', '2@0']);
    assert.equal(report.checked, 251);
    assert.deepEqual(
      report.problems.map((p) => [p.expected.title, p.matched.title]),
      [['Carrie', 'The Carrie Diaries']]
    );
    assert.deepEqual(
      (await plexMatchCheck.problemFor('series', { tvdbId: 455755 })).map(
        (p) => p.folder
      ),
      ['Carrie']
    );
    assert.deepEqual(
      (await plexMatchCheck.problemFor('series', { key: '126741' })).map(
        (p) => p.reason
      ),
      ['other'],
      'found from the side Plex matched it to'
    );
    assert.deepEqual(
      await plexMatchCheck.problemFor('series', { tvdbId: 353546 }),
      []
    );
  });

  it('keeps the last full report when a run is cancelled', async (t) => {
    t.after(() => fs.rm(REPORT_PATH, { force: true }));
    const settings = getSettings();
    settings.main.mediaServerType = MediaServerType.PLEX;
    settings.plex.libraries = [
      { id: '1', name: 'TV Shows', enabled: true, type: 'show' },
    ];
    settings.sonarr = [
      { id: 0, name: 'Sonarr', hostname: 's', port: 1, apiKey: 'k' },
    ] as unknown as SonarrSettings[];
    settings.radarr = [];
    t.mock.method(SonarrAPI.prototype, 'getSeries', async () => [
      { ...carrie, path: '/tv/Carrie' },
      { title: 'Bluey', year: 2018, tvdbId: 353546, path: '/tv/Bluey' },
    ]);
    const shows = [
      ...Array.from({ length: 250 }, (_, i) =>
        show(`b${i}`, 'Bluey', 'Bluey', ['tvdb://353546'])
      ),
      show('126741', 'The Carrie Diaries', 'Carrie', ['tvdb://257454']),
    ];
    let cancelAfterFirstPage = false;
    t.mock.method(
      PlexAPI.prototype,
      'getLibraryContents',
      async (_id: string, { offset = 0, size = 50 } = {}) => {
        if (cancelAfterFirstPage) {
          plexMatchCheck.cancel();
        }
        return {
          totalSize: shows.length,
          items: shows.slice(offset, offset + size),
        };
      }
    );

    await plexMatchCheck.run();
    const full = await plexMatchCheck.lastReport();
    assert.equal(full.checked, 251);
    assert.equal(full.problems.length, 1);

    // Stopped after the first page: Carrie, on the second, is never reached.
    cancelAfterFirstPage = true;
    await plexMatchCheck.run();

    const kept = await plexMatchCheck.lastReport();
    assert.equal(kept.checked, 251, 'not the 200 the cancelled run got to');
    assert.equal(kept.finishedAt, full.finishedAt);
    assert.equal(kept.problems.length, 1);
    assert.equal(
      (JSON.parse(await fs.readFile(REPORT_PATH, 'utf-8')) as typeof full)
        .checked,
      251,
      'nor in the kept file'
    );
  });
});

describe('Match Check on several servers', () => {
  const setUp = (t: { after: (fn: () => unknown) => void }) => {
    t.after(async () => {
      await fs.rm(REPORT_PATH, { force: true });
      const settings = getSettings();
      settings.main.mediaServerType = MediaServerType.NOT_CONFIGURED;
      settings.jellyfin.connected = false;
    });
    const settings = getSettings();
    settings.main.mediaServerType = MediaServerType.PLEX;
    settings.jellyfin = {
      ...settings.jellyfin,
      connected: true,
      ip: 'jf.invalid',
      apiKey: 'jk',
      libraries: [{ id: 'jtv', name: 'TV', enabled: true, type: 'show' }],
    };
    settings.plex.libraries = [
      { id: '1', name: 'TV Shows', enabled: true, type: 'show' },
    ];
    settings.sonarr = [
      { id: 0, name: 'Sonarr', hostname: 's', port: 1, apiKey: 'k' },
    ] as unknown as SonarrSettings[];
    settings.radarr = [];
  };

  it('checks every connected server, in one report', async (t) => {
    setUp(t);
    t.mock.method(SonarrAPI.prototype, 'getSeries', async () => [
      { ...carrie, path: '/tv/Carrie' },
    ]);
    t.mock.method(PlexAPI.prototype, 'getLibraryContents', async () => ({
      totalSize: 1,
      items: [
        show('126741', 'The Carrie Diaries', 'Carrie', ['tvdb://257454']),
      ],
    }));
    t.mock.method(JellyfinAPI.prototype, 'getLibraryPage', async () => ({
      TotalRecordCount: 1,
      Items: [
        {
          Id: 'jf-carrie',
          Name: 'The Carrie Diaries',
          Type: 'Series',
          Path: '/data/tv/Carrie',
          ProviderIds: { Tvdb: '257454' },
        },
      ],
    }));

    await plexMatchCheck.run();

    const report = await plexMatchCheck.lastReport();
    assert.equal(report.error, undefined);
    assert.equal(report.checked, 2);
    assert.deepEqual(
      report.problems.map((p) => [p.mediaServer, p.matched.key]).sort(),
      [
        ['Jellyfin', 'jf-carrie'],
        ['Plex', '126741'],
      ]
    );
    assert.equal(
      (await plexMatchCheck.problemFor('series', { tvdbId: 455755 })).length,
      2
    );
    // Found from the title it was wrongly matched to, by that server's id.
    assert.deepEqual(
      (
        await plexMatchCheck.problemFor('series', {
          keys: [{ mediaServer: 'Jellyfin', key: 'jf-carrie' }],
        })
      ).map((p) => p.mediaServer),
      ['Jellyfin']
    );
    assert.deepEqual(
      await plexMatchCheck.problemFor('series', {
        keys: [{ mediaServer: 'Emby', key: 'jf-carrie' }],
      }),
      []
    );
  });

  it('keeps what one server found when another cannot be read', async (t) => {
    setUp(t);
    t.mock.method(SonarrAPI.prototype, 'getSeries', async () => [
      { ...carrie, path: '/tv/Carrie' },
    ]);
    t.mock.method(PlexAPI.prototype, 'getLibraryContents', async () => ({
      totalSize: 1,
      items: [
        show('126741', 'The Carrie Diaries', 'Carrie', ['tvdb://257454']),
      ],
    }));
    t.mock.method(JellyfinAPI.prototype, 'getLibraryPage', async () => {
      throw new Error('connect ECONNREFUSED');
    });

    await plexMatchCheck.run();

    const report = await plexMatchCheck.lastReport();
    assert.equal(report.error, 'Jellyfin: connect ECONNREFUSED');
    assert.deepEqual(
      report.problems.map((p) => p.mediaServer),
      ['Plex']
    );
  });
});
