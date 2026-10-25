import type {
  MbRecording,
  MbRecordingRelease,
} from '@server/api/musicbrainz/interfaces';
import {
  groupSongs,
  splitTitle,
  toVersion,
  versionLabel,
} from '@server/lib/music/songs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const ARTIST = '3c9e5f21-8d47-4b6a-a1e3-5f7d2c90b844';
const GUEST = '5c72e1b9-4f3d-4a86-b917-d2a8f60c3e51';
const COVER_BAND = '8e2d6a4f-1b3c-4d5e-9f70-a1b2c3d4e5f6';

const release = (
  group: string,
  title: string,
  {
    type = 'Album',
    secondary = [] as string[],
    status = 'Official' as string | undefined,
    date = '2001-03-04',
  } = {}
): MbRecordingRelease => ({
  id: `${group}-r`,
  title,
  status,
  date,
  'release-group': {
    id: group,
    title,
    'primary-type': type,
    'secondary-types': secondary,
  },
});

let ids = 0;
const recording = (
  title: string,
  releases: MbRecordingRelease[],
  {
    disambiguation,
    artists = [ARTIST],
    video = false,
  }: { disambiguation?: string; artists?: string[]; video?: boolean } = {}
): MbRecording => ({
  id: `0000000${++ids}`.slice(-8) + '-0000-4000-8000-000000000000',
  title,
  disambiguation,
  length: 200_000,
  video,
  'artist-credit': artists.map((id, i) => ({
    name: id === ARTIST ? 'Glasswing' : `Artist ${i}`,
    joinphrase: i < artists.length - 1 ? ' feat. ' : '',
    artist: { id, name: 'X' },
  })),
  releases,
});

describe('splitTitle', () => {
  it('takes the version from brackets and a dash tail', () => {
    assert.deepEqual(splitTitle('Lantern Song (radio edit)'), {
      songTitle: 'Lantern Song',
      parts: ['radio edit'],
    });
    assert.deepEqual(splitTitle('Lantern Song (Club Mix) [Mixshow]'), {
      songTitle: 'Lantern Song',
      parts: ['Club Mix', 'Mixshow'],
    });
    assert.deepEqual(splitTitle('Lantern Song - Live at the Pier'), {
      songTitle: 'Lantern Song',
      parts: ['Live at the Pier'],
    });
  });

  it('keeps a dash or bracket that is part of the title', () => {
    assert.deepEqual(splitTitle('Here - There'), {
      songTitle: 'Here - There',
      parts: [],
    });
    assert.deepEqual(splitTitle('(Interlude)'), {
      songTitle: '(Interlude)',
      parts: [],
    });
  });
});

describe('versionLabel', () => {
  it("joins the title's version and MusicBrainz's note, once each", () => {
    assert.equal(
      versionLabel(
        recording('Lantern Song', [], { disambiguation: 'radio edit' })
      ),
      'radio edit'
    );
    assert.equal(
      versionLabel(
        recording('Lantern Song (radio edit)', [], {
          disambiguation: 'radio edit',
        })
      ),
      'radio edit'
    );
    assert.equal(
      versionLabel(
        recording('Lantern Song (Club Mix)', [], { disambiguation: 'live' })
      ),
      'Club Mix · live'
    );
    assert.equal(versionLabel(recording('Lantern Song', [])), null);
  });
});

describe('toVersion', () => {
  it('leaves out videos and versions only on bootlegs or DJ mixes', () => {
    const album = release('a1', 'Harbour Lights');
    assert.equal(toVersion(recording('A', [album], { video: true })), null);
    assert.equal(
      toVersion(
        recording('A', [release('b1', 'Live Tape', { status: 'Bootleg' })])
      ),
      null
    );
    assert.equal(
      toVersion(
        recording('A', [release('m1', 'Night Mix', { secondary: ['DJ-mix'] })])
      ),
      null
    );
    assert.equal(toVersion(recording('A', [])), null);
  });

  it('is best known from the artist’s own album, then a single', () => {
    const version = toVersion(
      recording('Lantern Song', [
        release('c1', 'Hits of the Year', {
          secondary: ['Compilation'],
          date: '1999-01-01',
        }),
        release('s1', 'Lantern Song', { type: 'Single', date: '2001-01-01' }),
        release('a1', 'Harbour Lights', { date: '2001-03-04' }),
        // A release without a status is counted, as MusicBrainz often has.
        release('a1', 'Harbour Lights', {
          status: undefined,
          date: '2000-12-01',
        }),
      ])
    );
    assert.ok(version);
    assert.equal(version.from?.mbId, 'a1');
    assert.equal(version.from?.date, '2000-12-01');
    assert.deepEqual(
      version.releaseGroups.map((group) => group.mbId),
      ['a1', 's1', 'c1']
    );
    assert.equal(version.releaseCount, 4);
    assert.equal(version.artistMbid, ARTIST);
  });
});

describe('groupSongs', () => {
  const album = release('a1', 'Harbour Lights');
  const single = release('s1', 'Lantern Song', { type: 'Single' });
  const comp = release('c1', 'Hits', { secondary: ['Compilation'] });

  it("puts an artist's versions of one title together, best known first", () => {
    const songs = groupSongs(
      [
        recording('Lantern Song (Club Mix)', [single]),
        recording('Lantern Song', [album, comp, comp]),
        recording('Lantern Song', [single, comp, comp, comp], {
          disambiguation: 'radio edit',
          artists: [ARTIST, GUEST],
        }),
        recording('Lantern Song Medley', [album], {
          disambiguation: 'live',
        }),
      ],
      'lantern song',
      [ARTIST]
    );

    assert.deepEqual(
      songs.map((song) => song.title),
      ['Lantern Song', 'Lantern Song Medley']
    );
    assert.deepEqual(
      songs[0].versions.map((version) => version.version),
      ['radio edit', null, 'Club Mix']
    );
    // Credited as its best-known version is.
    assert.equal(songs[0].artistName, 'Glasswing feat. Artist 1');
  });

  it('leaves out other artists and versions credited first to someone else', () => {
    const songs = groupSongs(
      [
        recording('Lantern Song', [album], { artists: [COVER_BAND] }),
        recording('Lantern Song (mash-up)', [album], {
          artists: [GUEST, ARTIST],
        }),
      ],
      'lantern song',
      [ARTIST]
    );
    assert.deepEqual(songs, []);
  });

  it('lists the artists given in their order, after exact titles', () => {
    const songs = groupSongs(
      [
        recording('Lantern Song Reprise', [album]),
        recording('Lantern Song', [album], { artists: [GUEST] }),
      ],
      'Lantern Song',
      [ARTIST, GUEST]
    );
    assert.deepEqual(
      songs.map((song) => [song.title, song.artistMbid]),
      [
        ['Lantern Song', GUEST],
        ['Lantern Song Reprise', ARTIST],
      ]
    );
  });
});
