import type { NumberedEpisode } from '@server/lib/agent/numbering';
import {
  episodeByTitle,
  indexerReading,
  nameReading,
  numbersInName,
  sceneDiffers,
} from '@server/lib/agent/numbering';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * Which library episode a release is, for a made-up series numbered as a
 * real one was on a live server: TVDB numbering in the library, the
 * scene's (TheXEM) for searches and names, releases named either way, a
 * special counted as episode 1, and two episodes sharing a title.
 */

const ep = (
  id: number,
  season: number,
  episode: number,
  title: string,
  hasFile: boolean,
  scene?: [number, number]
): NumberedEpisode => ({
  id,
  seasonNumber: season,
  episodeNumber: episode,
  title,
  hasFile,
  ...(scene
    ? { sceneSeasonNumber: scene[0], sceneEpisodeNumber: scene[1] }
    : {}),
});

const LIBRARY: NumberedEpisode[] = [
  ep(863, 0, 1, 'Behind the Map', false),
  ep(873, 1, 3, 'Thin Air', true),
  ep(893, 3, 1, 'Red Canyon', true),
  ep(895, 3, 3, 'Into the Furnace', false),
  ep(904, 4, 1, 'Long Road (1)', true),
  ep(905, 4, 2, 'Long Road (2)', false),
  ep(941, 8, 1, 'Island Exile', false, [6, 15]),
  ep(945, 8, 5, 'Thin Air', true, [7, 5]),
  ep(948, 9, 1, 'River Delta', true, [8, 1]),
  ep(953, 9, 6, 'Lion Country', false, [8, 6]),
  ep(990, 9, 9, 'Episode 9', false),
];
const byId = (id: number) => LIBRARY.find((e) => e.id === id)!;

describe('Release numbering', () => {
  it('reads the first season and episode a name gives', () => {
    assert.deepEqual(numbersInName('Far.Afield.S08E01.Island.Exile'), {
      season: 8,
      episode: 1,
    });
    assert.deepEqual(numbersInName('Show.S01E01E02.720p'), {
      season: 1,
      episode: 1,
    });
    assert.deepEqual(numbersInName('Show 3x04 Title'), {
      season: 3,
      episode: 4,
    });
    assert.equal(numbersInName('Far Afield Season 3 Complete'), undefined);
    assert.equal(numbersInName('Show.2019.1080p.x264'), undefined);
  });

  it('finds the episode a name’s title is, whatever its number', () => {
    assert.equal(
      episodeByTitle(
        'Far.Afield.S08E01.Island.Exile.720p.HDTV.x264-GRP',
        LIBRARY
      )?.id,
      941
    );
    // Some groups count the special as S03E01.
    assert.equal(
      episodeByTitle(
        'Far.Afield.S03E01.Behind.the.Map.1080p.AMZN.WEB-DL',
        LIBRARY
      )?.id,
      863
    );
    assert.equal(
      episodeByTitle('Far.Afield.S03E04.Into.the.Furnace.1080p', LIBRARY)?.id,
      895
    );
  });

  it('tells parts apart by their numbers', () => {
    assert.equal(
      episodeByTitle('Far.Afield.S04E02.Long.Road.Part.2.1080p', LIBRARY)?.id,
      905
    );
    assert.equal(
      episodeByTitle('Far.Afield.S04E01.Long.Road.Part.1.1080p', LIBRARY)?.id,
      904
    );
  });

  it('says nothing when two episodes share the title, or it is generic', () => {
    assert.equal(
      episodeByTitle('Far.Afield.S08E05.Thin.Air.720p', LIBRARY),
      undefined
    );
    assert.equal(
      episodeByTitle('Far.Afield.S09E09.Episode.9.720p', LIBRARY),
      undefined
    );
    assert.equal(
      episodeByTitle('Far.Afield.S09E01.720p.HDTV', LIBRARY),
      undefined
    );
  });

  it('knows which episodes the scene numbers differently', () => {
    assert.equal(sceneDiffers(byId(941)), true);
    assert.equal(sceneDiffers(byId(895)), false);
  });

  it('says when Sonarr’s mapping and the title disagree', () => {
    const name = 'Far.Afield.S08E01.Island.Exile.720p.HDTV.x264-GRP';
    assert.equal(
      nameReading(name, LIBRARY, byId(948)),
      'Sonarr maps it to S09E01 "River Delta" (on disk), but its title is library S08E01 "Island Exile" (missing): go by its title'
    );
    assert.equal(
      nameReading(
        'Far.Afield.S08E06.Lion.Country.HDTV.x264-GRP',
        LIBRARY,
        byId(953)
      ),
      'is S09E06 "Lion Country" (missing)'
    );
    assert.equal(
      nameReading('Far.Afield.S08E01.720p', LIBRARY, byId(948)),
      'Sonarr maps it to S09E01 "River Delta" (on disk)'
    );
  });

  it('reads indexer results by number, scene number and title', () => {
    assert.equal(
      indexerReading('Far.Afield.S08E01.Island.Exile.720p.HDTV', LIBRARY),
      'is S08E01 "Island Exile" (missing)'
    );
    assert.equal(
      indexerReading('Far.Afield.S03E01.Behind.the.Map.1080p', LIBRARY),
      'by its number S03E01 "Red Canyon" (on disk), but its title is S00E01 "Behind the Map" (missing): go by its title'
    );
    // No title: either numbering could be meant.
    assert.equal(
      indexerReading('Far.Afield.S08E01.720p.HDTV', LIBRARY),
      'S08E01 "Island Exile" (missing), or by the scene\'s numbering S09E01 "River Delta" (on disk): check the files\' titles'
    );
    assert.equal(indexerReading('Far.Afield.Complete.1080p', LIBRARY), '');
  });
});
