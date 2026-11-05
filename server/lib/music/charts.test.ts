import { MusicBrainz, musicBrainz } from '@server/api/musicbrainz';
import type { ChartSong } from '@server/lib/music/charts';
import {
  MOST_HELD,
  albumTitles,
  chartAlbumTitle,
  chartMatchesHeld,
  chartSongTitle,
  creditedNames,
  forgetChartMatches,
  plainName,
  songNamed,
  trending,
} from '@server/lib/music/charts';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

/*
 * Chart name parsing before MusicBrainz lookup, and the in-memory match
 * cache.
 */

setupTestDb();

afterEach(() => {
  mock.restoreAll();
  forgetChartMatches();
});

describe('a chart’s names', () => {
  it('drops what only credits someone from a song', () => {
    assert.equal(
      chartSongTitle('Ferry Lights (feat. Somebody)'),
      'Ferry Lights'
    );
    assert.equal(
      chartSongTitle('Ferry Lights [with Somebody]'),
      'Ferry Lights'
    );
    assert.equal(
      chartSongTitle('Ferry Lights (duet with Somebody)'),
      'Ferry Lights'
    );
    assert.equal(chartSongTitle('Ferry Lights (Live)'), 'Ferry Lights (Live)');
  });

  it('drops what Apple adds to an album', () => {
    assert.equal(chartAlbumTitle('Harbour Songs - EP'), 'Harbour Songs');
    assert.equal(chartAlbumTitle('Harbour Songs - Single'), 'Harbour Songs');
    assert.equal(
      chartAlbumTitle('Harbour Songs (Deluxe Edition)'),
      'Harbour Songs'
    );
    assert.deepEqual(albumTitles('Harbour Songs: The Encore'), [
      'Harbour Songs: The Encore',
      'Harbour Songs',
    ]);
  });

  it('tries the whole credit, then its first name', () => {
    assert.deepEqual(creditedNames('Glasswing & Somebody'), [
      'Glasswing & Somebody',
      'Glasswing',
    ]);
    assert.deepEqual(creditedNames('Glasswing, B & C'), [
      'Glasswing, B & C',
      'Glasswing',
    ]);
    assert.deepEqual(creditedNames('Glasswing'), ['Glasswing']);
  });

  it('compares names without case, accents or punctuation', () => {
    assert.equal(plainName('Café  Tacvba!'), plainName('cafe tacvba'));
    assert.equal(plainName('Salt & Sand'), plainName('Salt and Sand'));
  });

  it('counts a song as trending when it came out in the last month', () => {
    const now = Date.parse('2026-10-27T00:00:00Z');
    const song = (id: string, releaseDate?: string) =>
      ({ entry: { id, name: id, artistName: 'A', releaseDate } }) as ChartSong;
    assert.deepEqual(
      trending(
        [song('new', '2026-10-20'), song('old', '2026-08-01'), song('undated')],
        now
      ).map(({ entry }) => entry.id),
      ['new']
    );
  });
});

describe('matches held in memory', () => {
  it('stay a bounded few, however many artists playlists name', async () => {
    mock.method(MusicBrainz.prototype, 'searchArtists', async () => ({
      count: 0,
      offset: 0,
      artists: [],
    }));
    for (let n = 0; n < MOST_HELD + 50; n++) {
      assert.equal(await songNamed('Ferry Lights', `Act number ${n}`), null);
    }
    assert.equal(chartMatchesHeld(), MOST_HELD);
  });
});

describe('a song a playlist names', () => {
  const ARTIST = '3c9e5f21-8d47-4b6a-a1e3-5f7d2c90b844';
  const recording = (id: string, title: string, length: number) => ({
    id,
    title,
    length,
    'artist-credit': [
      { name: 'Glasswing', artist: { id: ARTIST, name: 'Glasswing' } },
    ],
    releases: [
      {
        id: `${id.slice(0, 30)}r1`,
        title,
        status: 'Official',
        date: '2011-08-09',
        'release-group': {
          id: `${id.slice(0, 30)}g1`,
          title,
          'primary-type': 'Single',
          'secondary-types': [],
        },
      },
    ],
  });
  const RECORDINGS = [
    recording(
      'a1b2c3d4-0001-4000-8000-000000000001',
      'Harbour Girl (Tide Me Over)',
      226_000
    ),
    recording('a1b2c3d4-0002-4000-8000-000000000002', 'Glass Road', 113_000),
    recording(
      'a1b2c3d4-0003-4000-8000-000000000003',
      'Glass Road (remix)',
      157_000
    ),
    recording(
      'a1b2c3d4-0004-4000-8000-000000000004',
      'Lanterns, Salt, & Sand (The Loud One)',
      196_000
    ),
  ];
  /** Mimics MusicBrainz phrase search: consecutive words, "&" dropped. */
  const words = (text: string) =>
    plainName(text.replace(/&/g, ' ')).split(' ').filter(Boolean).join(' ');
  const asked: string[] = [];

  const useMusicBrainz = () => {
    asked.length = 0;
    mock.method(MusicBrainz.prototype, 'searchArtists', async () => ({
      count: 1,
      offset: 0,
      artists: [{ id: ARTIST, name: 'Glasswing', score: 100 }],
    }));
    mock.method(
      MusicBrainz.prototype,
      'searchRecordings',
      async (phrase: string) => {
        asked.push(phrase);
        const found = RECORDINGS.filter((r) =>
          ` ${words(r.title)} `.includes(` ${words(phrase)} `)
        );
        return { count: found.length, offset: 0, recordings: found };
      }
    );
  };

  it('is found when its title has a part in brackets', async () => {
    useMusicBrainz();
    const song = await songNamed('Harbour Girl (Tide Me Over)', 'Glasswing');
    assert.equal(song?.versions[0].title, 'Harbour Girl (Tide Me Over)');
    // Cached, so requesting it needs no second lookup.
    assert.equal(
      (await musicBrainz().keptRecording(song!.versions[0].mbId))?.title,
      'Harbour Girl (Tide Me Over)'
    );
  });

  it('is the version its title names', async () => {
    useMusicBrainz();
    const song = await songNamed(
      'Glass Road (feat. Somebody) [Remix]',
      'Glasswing'
    );
    assert.deepEqual(
      song?.versions.map((v) => v.title),
      ['Glass Road (remix)']
    );
    // A plain title picks the plain version.
    const plain = await songNamed('Glass Road', 'Glasswing');
    assert.deepEqual(
      plain?.versions.map((v) => v.title),
      ['Glass Road']
    );
  });

  it('is found with "and" where MusicBrainz has "&"', async () => {
    useMusicBrainz();
    const song = await songNamed(
      'Lanterns, Salt and Sand (The Loud One)',
      'Glasswing'
    );
    assert.ok(song);
    assert.deepEqual(asked, ['Lanterns, Salt and Sand', 'Lanterns, Salt Sand']);
  });
});
