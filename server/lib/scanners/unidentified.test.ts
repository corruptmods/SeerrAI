import {
  NotIdentifiedError,
  UnidentifiedTitles,
  nameOf,
  unidentifiedSummary,
} from '@server/lib/scanners/unidentified';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * The one line a scan ends with when the media server had titles it has
 * not identified yet, instead of an error for each.
 */

const emby = {
  server: 'Emby',
  verb: 'identified' as const,
  hint: "refresh the library's metadata, or use Identify on a title",
};

describe('titles the server has not identified yet', () => {
  it('counts films and series apart, in plain words', () => {
    assert.equal(
      unidentifiedSummary({ ...emby, films: 38, series: 4 }),
      "Emby: 38 films and 4 series aren't identified by Emby yet, so they were skipped. They'll be picked up once Emby has identified them (in Emby: refresh the library's metadata, or use Identify on a title)."
    );
  });

  it('speaks of one title as one', () => {
    assert.equal(
      unidentifiedSummary({ ...emby, films: 1, series: 0 }),
      "Emby: 1 film isn't identified by Emby yet, so it was skipped. It'll be picked up once Emby has identified it (in Emby: refresh the library's metadata, or use Identify on a title)."
    );
    assert.match(
      unidentifiedSummary({ ...emby, films: 0, series: 1 }),
      /^Emby: 1 series isn't identified by Emby yet, so it was skipped\./
    );
    assert.match(
      unidentifiedSummary({ ...emby, films: 0, series: 3 }),
      /^Emby: 3 series aren't identified/
    );
  });

  it('names each server by its own name and word', () => {
    const jellyfin = unidentifiedSummary({
      ...emby,
      server: 'Jellyfin',
      films: 2,
      series: 0,
    });
    assert.match(jellyfin, /^Jellyfin: 2 films aren't identified by Jellyfin/);
    assert.doesNotMatch(jellyfin, /Emby/);

    const plex = unidentifiedSummary({
      server: 'Plex',
      verb: 'matched',
      hint: "refresh the library's metadata, or use Match on a title",
      films: 2,
      series: 1,
    });
    assert.equal(
      plex,
      "Plex: 2 films and 1 series aren't matched by Plex yet, so they were skipped. They'll be picked up once Plex has matched them (in Plex: refresh the library's metadata, or use Match on a title)."
    );
  });

  it('keeps count through a scan, with the first five names', () => {
    const titles = new UnidentifiedTitles(emby);
    assert.equal(titles.summary(), undefined, 'nothing skipped, nothing said');

    for (let i = 1; i <= 6; i++) {
      titles.add('film', {
        name: `Film ${i}`,
        year: 2000 + i,
        type: 'Movie',
        id: `${i}`,
      });
    }
    const line = titles.add('series', {
      name: 'A Show',
      type: 'Series',
      id: 's',
    });
    assert.equal(line, "Skipped A Show: Emby hasn't identified it yet");

    const summary = titles.summary();
    assert.match(summary?.message ?? '', /^Emby: 6 films and 1 series /);
    assert.deepEqual(summary?.examples, [
      'Film 1 (2001)',
      'Film 2 (2002)',
      'Film 3 (2003)',
      'Film 4 (2004)',
      'Film 5 (2005)',
    ]);

    titles.clear();
    assert.equal(titles.summary(), undefined, 'a new scan starts afresh');
  });

  it('keeps the message the scan always gave', () => {
    const error = new NotIdentifiedError('film', {
      name: 'Blood',
      type: 'movie',
      id: '501',
    });
    assert.equal(error.message, 'Unable to find TMDB ID');
    assert.ok(error instanceof Error);
    assert.equal(nameOf(error.item), 'Blood');
  });
});
