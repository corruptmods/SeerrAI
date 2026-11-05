import { MediaRequestStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import SongFetch from '@server/entity/SongFetch';
import downloadTracker from '@server/lib/downloadtracker';
import { songProgress } from '@server/lib/music/songProgress';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

/*
 * Per-song progress on a playlist page: single search, album search, retry
 * wait, download and import.
 */

setupTestDb();

const ALBUM = '4f6a2d93-c1e8-3a57-9b02-6d3e8f1c7a40';
const SINGLE = '9b1f0c55-2d0e-4a8c-9f4e-3e1c7b2a5d10';
const LANTERN = 'a1b2c3d4-0001-4000-8000-000000000001';
const OPENING = 'a1b2c3d4-0001-4000-8000-000000000002';
const NOW = new Date('2026-11-03T12:00:00Z');

const fromAlbum = (recordingMbid = LANTERN) => ({
  recordingMbid,
  status: MediaRequestStatus.APPROVED,
  singleMbid: null,
  singleTitle: null,
  sourceAlbumMbid: ALBUM,
  sourceAlbumTitle: 'Static Garden',
});

const fetchWith = (fields: Partial<SongFetch>) =>
  getRepository(SongFetch).save(
    new SongFetch({
      albumMbid: ALBUM,
      albumTitle: 'Static Garden',
      artistMbid: 'b0a1c2d3-0000-4000-8000-000000000001',
      artistName: 'Glasswing',
      recordings: [LANTERN],
      status: 'searching',
      lidarrId: 0,
      lidarrArtistId: 7,
      lidarrAlbumId: 40,
      files: [],
      tried: [],
      ...fields,
    })
  );

afterEach(() => {
  downloadTracker.setSongDownloads([]);
});

describe('a requested song’s progress', () => {
  it('says Lidarr is looking for the single, then downloading it', async () => {
    const song = {
      ...fromAlbum(),
      singleMbid: SINGLE,
      singleTitle: 'Lantern Song',
      sourceAlbumMbid: null,
      sourceAlbumTitle: null,
    };
    let progress = await songProgress([song], NOW);
    assert.deepEqual(progress.get(LANTERN), {
      step: 'single',
      release: 'Lantern Song',
    });

    downloadTracker.setSongDownloads([
      {
        serverId: 0,
        item: {
          mediaType: 'music',
          externalId: 7,
          size: 1000,
          sizeLeft: 250,
          status: '',
          stage: 'downloading',
          timeLeft: '',
          title: 'Glasswing - Lantern Song',
          downloadId: 'd1',
          album: { id: 41, title: 'Lantern Song', foreignAlbumId: SINGLE },
        } as never,
      },
    ]);
    progress = await songProgress([song], NOW);
    assert.deepEqual(progress.get(LANTERN), {
      step: 'downloading',
      release: 'Lantern Song',
      percent: 75,
    });
  });

  it('follows the search for its album, and its wait to search again', async () => {
    const fetch = await fetchWith({});
    assert.deepEqual((await songProgress([fromAlbum()], NOW)).get(LANTERN), {
      step: 'searching',
      release: 'Static Garden',
    });

    const later = new Date('2026-11-03T15:00:00Z');
    await getRepository(SongFetch).update(fetch.id, { searchAgainAt: later });
    assert.deepEqual((await songProgress([fromAlbum()], NOW)).get(LANTERN), {
      step: 'waiting',
      release: 'Static Garden',
      searchAgainAt: later,
    });
  });

  it('says when the album’s download is under way, then importing', async () => {
    const fetch = await fetchWith({ status: 'downloading' });
    assert.deepEqual((await songProgress([fromAlbum()], NOW)).get(LANTERN), {
      step: 'downloading',
      release: 'Static Garden',
      percent: null,
    });
    await getRepository(SongFetch).update(fetch.id, { status: 'importing' });
    assert.deepEqual((await songProgress([fromAlbum()], NOW)).get(LANTERN), {
      step: 'importing',
      release: 'Static Garden',
    });
  });

  it('is getting ready before its album has a fetch, and says nothing once done', async () => {
    const progress = await songProgress(
      [
        fromAlbum(OPENING),
        { ...fromAlbum(), status: MediaRequestStatus.COMPLETED },
      ],
      NOW
    );
    assert.deepEqual(progress.get(OPENING), {
      step: 'preparing',
      release: 'Static Garden',
    });
    assert.equal(progress.has(LANTERN), false);
  });
});
