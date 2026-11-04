import type { DeezerTrack } from '@server/api/deezer';
import DeezerAPI from '@server/api/deezer';
import {
  addToMusicBrainzUrl,
  catalogSong,
  trackFor,
} from '@server/lib/music/catalogSong';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

/*
 * A playlist's song as Deezer lists it: the same artist, title and take,
 * as long as the playlist says, for its ISRC and album. Names are invented.
 */

const track = (
  id: number,
  title: string,
  seconds: number,
  {
    artist = 'Glasswing',
    version = '',
  }: { artist?: string; version?: string } = {}
): DeezerTrack => ({
  id,
  title: version ? `${title} ${version}` : title,
  title_short: title,
  title_version: version,
  duration: seconds,
  artist: { id: 1, name: artist },
  album: { id: 100 + id, title: 'Harbour Lights' },
});

afterEach(() => mock.restoreAll());

describe('the Deezer track a playlist song is', () => {
  it('is by its artist, titled as it is, and as long', () => {
    const tracks = [
      track(1, 'Lantern Song', 214, { artist: 'Static Garden' }),
      track(2, 'Lantern Songs', 214),
      track(3, 'Lantern Song', 260),
      track(4, 'Lantern Song', 216),
    ];
    assert.equal(trackFor(tracks, 'Lantern Song', 'Glasswing', 214_500)?.id, 4);
    // No length to go by: the best known of the rest.
    assert.equal(trackFor(tracks, 'Lantern Song', 'Glasswing', null)?.id, 3);
    assert.equal(trackFor(tracks, 'Night Swim', 'Glasswing', null), undefined);
  });

  it('is never another take the title doesn’t name', () => {
    const tracks = [
      track(1, 'Lantern Song', 215, { version: '(Live)' }),
      track(2, 'Lantern Song', 215, { version: '(Acoustic Version)' }),
    ];
    assert.equal(
      trackFor(tracks, 'Lantern Song', 'Glasswing', 215_000),
      undefined
    );
    assert.equal(
      trackFor(tracks, 'Lantern Song (Live)', 'Glasswing', 215_000)?.id,
      1
    );
    // A radio edit or a remaster is the same take.
    assert.equal(
      trackFor(
        [track(3, 'Lantern Song', 215, { version: '(Radio Edit)' })],
        'Lantern Song',
        'Glasswing',
        215_000
      )?.id,
      3
    );
  });

  it('is titled in full as the playlist titles it, when several are', () => {
    const tracks = [
      track(1, 'Lantern Song', 215),
      track(2, 'Lantern Song', 216, { version: '(Radio Edit)' }),
    ];
    assert.equal(
      trackFor(tracks, 'Lantern Song (Radio Edit)', 'Glasswing', 215_000)?.id,
      2
    );
  });
});

describe('a song looked up on Deezer', () => {
  it('has its ISRC and where it is on its album', async () => {
    const searched: string[] = [];
    mock.method(
      DeezerAPI.prototype,
      'searchTracks',
      async (title: string, artist: string) => {
        searched.push(`${artist}: ${title}`);
        return artist === 'Glasswing' ? [track(7, 'Lantern Song', 215)] : [];
      }
    );
    mock.method(DeezerAPI.prototype, 'getTrack', async () => ({
      ...track(7, 'Lantern Song', 215),
      isrc: 'qz-abc-26-00001',
      track_position: 3,
      disk_number: 1,
      release_date: '2021-05-07',
    }));
    const song = await catalogSong(
      'Lantern Song (feat. Harbour Lights)',
      'Glasswing & Harbour Lights',
      215_000
    );
    // As credited first, then the first artist of several.
    assert.deepEqual(searched, [
      'Glasswing & Harbour Lights: Lantern Song',
      'Glasswing: Lantern Song',
    ]);
    assert.deepEqual(song, {
      deezerId: 7,
      title: 'Lantern Song',
      artistName: 'Glasswing',
      isrc: 'QZABC2600001',
      albumId: 107,
      album: 'Harbour Lights',
      trackNumber: 3,
      discNumber: 1,
      releaseDate: '2021-05-07',
      length: 215_000,
    });
  });

  it('has no ISRC when Deezer’s isn’t one', async () => {
    mock.method(DeezerAPI.prototype, 'searchTracks', async () => [
      track(7, 'Lantern Song', 215),
    ]);
    mock.method(DeezerAPI.prototype, 'getTrack', async () => ({
      ...track(7, 'Lantern Song', 215),
      isrc: '',
    }));
    assert.equal(
      (await catalogSong('Lantern Song', 'Glasswing', 215_000))?.isrc,
      null
    );
  });

  it('is null when Deezer lists no such song', async () => {
    mock.method(DeezerAPI.prototype, 'searchTracks', async () => []);
    assert.equal(await catalogSong('Lantern Song', 'Glasswing', null), null);
  });

  it('can be added to MusicBrainz through Harmony, from its album', () => {
    assert.equal(
      addToMusicBrainzUrl(777),
      'https://harmony.pulsewidth.org.uk/release?deezer=777'
    );
  });
});
