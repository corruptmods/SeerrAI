import type { ChartSong } from '@server/lib/music/charts';
import {
  albumTitles,
  chartAlbumTitle,
  chartSongTitle,
  creditedNames,
  plainName,
  trending,
} from '@server/lib/music/charts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * How a chart's names are read before they are looked for on MusicBrainz.
 */

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
