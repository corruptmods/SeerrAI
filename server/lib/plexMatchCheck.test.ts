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
  radarrFileFacts,
} from '@server/lib/plexMatchCheck';
import type { SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { describe, it } from 'node:test';

/*
 * Plex matched the folder "Wrenna" (Sonarr: Wrenna, 2026) to The Wrenna
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

const wrenna = {
  title: 'Wrenna',
  year: 2026,
  tvdbId: 577104,
  tmdbId: 375182,
  server: 'Sonarr',
};

describe('Plex Match Check, one item at a time', () => {
  it('reads folder names however the slashes lean', () => {
    assert.equal(folderName('/tv/Wrenna/'), 'Wrenna');
    assert.equal(folderName('D:\\TV\\Wrenna'), 'Wrenna');
  });

  it('reads ids from new agents and legacy ones', () => {
    assert.deepEqual(
      plexIds(
        show('1', 'x', 'x', [
          'tvdb://364817',
          'tmdb://57284',
          'imdb://tt2167477',
        ])
      ),
      { tvdbId: 364817, tmdbId: 57284, imdbId: 'tt2167477' }
    );
    assert.deepEqual(
      plexIds(
        show('1', 'x', 'x', [], 'com.plexapp.agents.thetvdb://577104?lang=en')
      ),
      { tvdbId: 577104 }
    );
  });

  it('flags a folder Plex matched to another series', () => {
    const byFolder = new Map([['wrenna', [wrenna]]]);
    const { checked, problem } = compareItem(
      'series',
      show('126741', 'The Wrenna Diaries', 'Wrenna', [
        'tvdb://364817',
        'tmdb://57284',
      ]),
      byFolder
    );
    assert.equal(checked, true);
    assert.equal(problem?.reason, 'other');
    assert.equal(problem?.folder, 'Wrenna');
    assert.equal(problem?.matched.key, '126741');
    assert.equal(problem?.expected.tvdbId, 577104);
  });

  it('leaves alone a folder Plex matched rightly, and one Sonarr does not have', () => {
    const byFolder = new Map([['wrenna', [wrenna]]]);
    assert.deepEqual(
      compareItem(
        'series',
        show('1', 'Wrenna', 'Wrenna', ['tvdb://577104']),
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
      show('3', 'Wrenna', 'Wrenna', [], 'local://3'),
      new Map([['wrenna', [wrenna]]])
    );
    assert.equal(problem?.reason, 'unmatched');
  });

  it('finds a movie by the folder its file is in', () => {
    const byFolder = new Map([
      [
        'adopted (2026)',
        [{ title: 'Adopted', year: 2026, tmdbId: 1482754, server: 'Radarr' }],
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
          'tmdb://1482754',
        ]),
        byFolder
      ).problem,
      undefined
    );
  });
});

describe('Plex Match Check, two titles with one name', () => {
  // Folders that read "Plex matched Quillmore (2025) to Quillmore (2025)":
  // the names agree and the ids don't, so the ids are what must be shown.
  const quillmore = {
    title: 'Quillmore',
    year: 2025,
    tmdbId: 1000,
    imdbId: 'tt1000',
    server: 'radarr',
  };
  const byFolder = new Map([['quillmore (2025)', [quillmore]]]);
  const plexQuillmore = (ids: string[]) => ({
    ...movie('7', 'Quillmore', '/m/Quillmore (2025)/a.mkv', ids),
    year: 2025,
  });

  it('calls a same-named film with other ids another film, and shows both ids', () => {
    const { problem } = compareItem(
      'movie',
      plexQuillmore(['tmdb://2000', 'imdb://tt2000']),
      byFolder
    );
    assert.equal(problem?.reason, 'other');
    const text = plexMatchText(problem as PlexMatchProblem);
    assert.equal(
      text.title,
      'Plex matched "Quillmore (2025)" to a different film named Quillmore (2025)'
    );
    assert.match(text.detail, /radarr: TMDB 1000, Plex: TMDB 2000/);
    assert.match(text.detail, /Fix Match in Plex, searching tmdb-1000/);
  });

  it('tells apart the same film under another TMDB entry', () => {
    const { problem } = compareItem(
      'movie',
      plexQuillmore(['tmdb://2000', 'imdb://tt1000']),
      byFolder
    );
    assert.equal(problem?.reason, 'differentId');
    const text = plexMatchText(problem as PlexMatchProblem);
    assert.equal(
      text.title,
      'Plex and radarr use different entries for Quillmore (2025)'
    );
    assert.match(text.detail, /The same title by IMDb \(tt1000\)/);
    assert.match(text.detail, /radarr: TMDB 1000, Plex: TMDB 2000/);
  });

  it('still names a differently named match plainly', () => {
    const { problem } = compareItem(
      'movie',
      {
        ...movie('8', 'Guerra Fronteriza', '/m/Border Feud (2024)/c.mkv', [
          'tmdb://3',
        ]),
        year: 2024,
      },
      new Map([
        [
          'border feud (2024)',
          [
            {
              title: 'Border Feud',
              year: 2024,
              tmdbId: 846213,
              server: 'radarr',
            },
          ],
        ],
      ])
    );
    assert.equal(
      plexMatchText(problem as PlexMatchProblem).title,
      'Plex matched "Border Feud (2024)" to Guerra Fronteriza (2024)'
    );
  });
});

describe('Plex Match Check, saying whose mistake it is', () => {
  // From the owner's 29 reports: Plex matched features to shorts of the
  // same name, often by IMDb id alone; one folder held the short itself.
  const radarr = (over: Record<string, unknown>) => ({
    title: 'Brine',
    year: 2023,
    tmdbId: 1000,
    imdbId: 'tt14391165',
    server: 'Radarr',
    ...over,
  });
  const check = (
    expected: Record<string, unknown>,
    plex: { title: string; year?: number; guids: string[]; folder: string }
  ) =>
    plexMatchText(
      compareItem(
        'movie',
        {
          ...movie('9', plex.title, `/m/${plex.folder}/a.mkv`, plex.guids),
          year: plex.year,
        },
        new Map([[plex.folder.toLowerCase(), [radarr(expected)]]])
      ).problem as PlexMatchProblem
    );

  it('shows the ids that disagreed, and the IMDb id to search too', () => {
    const text = check(
      {},
      { title: 'Brine', guids: ['imdb://tt27869543'], folder: 'Brine (2023)' }
    );
    assert.match(text.detail, /Radarr: IMDb tt14391165, Plex: IMDb tt27869543/);
    assert.match(
      text.detail,
      /Fix Match in Plex, searching tmdb-1000 or imdb-tt14391165/
    );
  });

  it('takes a missing year as unknown, not different', () => {
    const text = check(
      {},
      { title: 'Brine', guids: ['imdb://tt27869543'], folder: 'Brine (2023)' }
    );
    assert.equal(
      text.title,
      'Plex matched "Brine (2023)" to a different film named Brine'
    );
  });

  it('says when the file, not the match, is likely wrong', () => {
    const text = check(
      {
        title: 'Lost on the Ridge',
        year: 2022,
        tmdbId: 763842,
        imdbId: undefined,
        runtime: 90,
        fileRuntime: 21,
      },
      {
        title: 'Roostling',
        year: 2022,
        guids: ['tmdb://817364'],
        folder: 'Lost on the Ridge (2022)',
      }
    );
    assert.equal(
      text.title,
      'Radarr\'s file in "Lost on the Ridge (2022)" may not be Lost on the Ridge (2022)'
    );
    assert.match(text.detail, /file 21 min, film 90 min/);
    assert.match(text.detail, /Replace it in Radarr/);
    assert.doesNotMatch(text.detail, /Fix Match/);
  });

  it('suggests renaming a file not named after the film', () => {
    const borderFeud = {
      title: 'Border Feud',
      year: 2024,
      tmdbId: 846213,
      imdbId: undefined,
      runtime: 109,
      fileRuntime: 109,
    };
    const plex = {
      title: 'Guerra Fronteriza',
      year: 2024,
      guids: ['tmdb://1427986'],
      folder: 'Border Feud (2024)',
    };
    const text = check(
      { ...borderFeud, file: 'Guerra.Fronteriza.2024.1080p.WEB-DL.mkv' },
      plex
    );
    assert.match(text.detail, /file 109 min, film 109 min/);
    assert.match(text.detail, /rename the file in Radarr/);
    assert.doesNotMatch(
      check({ ...borderFeud, file: 'Border Feud (2024) WEBDL-1080p.mkv' }, plex)
        .detail,
      /rename/
    );
  });

  it('reads the file facts Radarr keeps, and the server’s length when it has none', () => {
    assert.deepEqual(
      radarrFileFacts({
        runtime: 90,
        movieFile: {
          relativePath: 'Roostling.2022.1080p.BluRay.x264-TriPOLAR.mkv',
          mediaInfo: { runTime: '21:27' },
        } as never,
      }),
      {
        runtime: 90,
        fileRuntime: 21,
        file: 'Roostling.2022.1080p.BluRay.x264-TriPOLAR.mkv',
      }
    );
    const { problem } = compareItem(
      'movie',
      {
        ...movie('9', 'Roostling', '/m/Departa (2022)/a.mkv', [
          'tmdb://817364',
        ]),
        Media: [
          {
            duration: 21 * 60_000,
            Part: [{ file: '/m/Departa (2022)/a.mkv' }],
          },
        ],
      } as unknown as PlexLibraryItem,
      new Map([['departa (2022)', [radarr({ tmdbId: 763842, runtime: 90 })]]])
    );
    assert.equal(problem?.expected.fileRuntime, 21);
    assert.equal(problem?.matched.duration, 21);
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
      { ...wrenna, path: '/tv/Wrenna' },
      { title: 'Pipkin', year: 2018, tvdbId: 462781, path: '/tv/Pipkin' },
    ]);
    const shows = [
      show('126741', 'The Wrenna Diaries', 'Wrenna', ['tvdb://364817']),
      ...Array.from({ length: 250 }, (_, i) =>
        show(`b${i}`, 'Pipkin', 'Pipkin', ['tvdb://462781'])
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
      [['Wrenna', 'The Wrenna Diaries']]
    );
    assert.deepEqual(
      (await plexMatchCheck.problemFor('series', { tvdbId: 577104 })).map(
        (p) => p.folder
      ),
      ['Wrenna']
    );
    assert.deepEqual(
      (await plexMatchCheck.problemFor('series', { key: '126741' })).map(
        (p) => p.reason
      ),
      ['other'],
      'found from the side Plex matched it to'
    );
    assert.deepEqual(
      await plexMatchCheck.problemFor('series', { tvdbId: 462781 }),
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
      { ...wrenna, path: '/tv/Wrenna' },
      { title: 'Pipkin', year: 2018, tvdbId: 462781, path: '/tv/Pipkin' },
    ]);
    const shows = [
      ...Array.from({ length: 250 }, (_, i) =>
        show(`b${i}`, 'Pipkin', 'Pipkin', ['tvdb://462781'])
      ),
      show('126741', 'The Wrenna Diaries', 'Wrenna', ['tvdb://364817']),
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

    // Stopped after the first page: Wrenna, on the second, is never reached.
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
      { ...wrenna, path: '/tv/Wrenna' },
    ]);
    t.mock.method(PlexAPI.prototype, 'getLibraryContents', async () => ({
      totalSize: 1,
      items: [
        show('126741', 'The Wrenna Diaries', 'Wrenna', ['tvdb://364817']),
      ],
    }));
    t.mock.method(JellyfinAPI.prototype, 'getLibraryPage', async () => ({
      TotalRecordCount: 1,
      Items: [
        {
          Id: 'jf-wrenna',
          Name: 'The Wrenna Diaries',
          Type: 'Series',
          Path: '/data/tv/Wrenna',
          ProviderIds: { Tvdb: '364817' },
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
        ['Jellyfin', 'jf-wrenna'],
        ['Plex', '126741'],
      ]
    );
    assert.equal(
      (await plexMatchCheck.problemFor('series', { tvdbId: 577104 })).length,
      2
    );
    // Found from the title it was wrongly matched to, by that server's id.
    assert.deepEqual(
      (
        await plexMatchCheck.problemFor('series', {
          keys: [{ mediaServer: 'Jellyfin', key: 'jf-wrenna' }],
        })
      ).map((p) => p.mediaServer),
      ['Jellyfin']
    );
    assert.deepEqual(
      await plexMatchCheck.problemFor('series', {
        keys: [{ mediaServer: 'Emby', key: 'jf-wrenna' }],
      }),
      []
    );
    // An id without its server is taken as Plex's.
    assert.deepEqual(
      await plexMatchCheck.problemFor('series', { key: 'jf-wrenna' }),
      []
    );
  });

  it('leaves out a server removed while it runs', async (t) => {
    setUp(t);
    t.mock.method(SonarrAPI.prototype, 'getSeries', async () => [
      { ...wrenna, path: '/tv/Wrenna' },
    ]);
    t.mock.method(PlexAPI.prototype, 'getLibraryContents', async () => ({
      totalSize: 1,
      items: [
        show('126741', 'The Wrenna Diaries', 'Wrenna', ['tvdb://364817']),
      ],
    }));
    t.mock.method(JellyfinAPI.prototype, 'getLibraryPage', async () => {
      // Removed in Settings → Media Servers while its library is read.
      getSettings().jellyfin.connected = false;
      await plexMatchCheck.dropServer('Jellyfin');
      return {
        TotalRecordCount: 1,
        Items: [
          {
            Id: 'jf-wrenna',
            Name: 'The Wrenna Diaries',
            Type: 'Series',
            Path: '/data/tv/Wrenna',
            ProviderIds: { Tvdb: '364817' },
          },
        ],
      };
    });

    await plexMatchCheck.run();

    const report = await plexMatchCheck.lastReport();
    assert.deepEqual(
      report.problems.map((p) => p.mediaServer),
      ['Plex']
    );
    assert.deepEqual(
      (
        JSON.parse(await fs.readFile(REPORT_PATH, 'utf-8')) as typeof report
      ).problems.map((p) => p.mediaServer),
      ['Plex'],
      'nor in the kept file'
    );
  });

  it('keeps what one server found when another cannot be read', async (t) => {
    setUp(t);
    t.mock.method(SonarrAPI.prototype, 'getSeries', async () => [
      { ...wrenna, path: '/tv/Wrenna' },
    ]);
    t.mock.method(PlexAPI.prototype, 'getLibraryContents', async () => ({
      totalSize: 1,
      items: [
        show('126741', 'The Wrenna Diaries', 'Wrenna', ['tvdb://364817']),
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
