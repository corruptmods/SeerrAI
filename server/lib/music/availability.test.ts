import { MediaStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import MusicAlbum from '@server/entity/MusicAlbum';
import { applyLidarr } from '@server/lib/music/availability';
import type { IndexAlbum, LidarrIndex } from '@server/lib/music/matcher';
import { setupTestDb } from '@server/test/db';
import {
  MUSIC_FIXTURE_IDS as IDS,
  seedMusicFixtures,
} from '@server/utils/seedTestDb';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

setupTestDb();

/** Lidarr knowing just these albums. */
const indexOf = (albums: Partial<IndexAlbum>[]): LidarrIndex => {
  const full = albums.map(
    (album) =>
      ({
        serverId: 0,
        id: 71,
        artistMbid: IDS.artist,
        title: 'Static Garden',
        secondaryTypes: [],
        monitored: false,
        releaseIds: [],
        ...album,
      }) as IndexAlbum
  );
  return {
    allAlbums: () => full,
    album: (mbid?: string | null) => full.find((a) => a.mbid === mbid),
  } as unknown as LidarrIndex;
};

const addedAt = async (mbId: string) =>
  (await getRepository(MusicAlbum).findOneByOrFail({ mbId })).mediaAddedAt;

describe('an album Lidarr has more of', () => {
  it('is added again, so it is back at the front of Recently Added', async () => {
    await seedMusicFixtures();
    const before = new Date(Date.now() - 86_400_000);
    await getRepository(MusicAlbum).update(
      { mbId: IDS.otherAlbum },
      { status: MediaStatus.PARTIALLY_AVAILABLE, mediaAddedAt: before }
    );

    await applyLidarr(
      indexOf([{ mbid: IDS.otherAlbum, trackCount: 12, trackFileCount: 4 }]),
      { decide: false }
    );
    assert.ok(((await addedAt(IDS.otherAlbum)) as Date) > before);
  });

  it('keeps its date when nothing more came, or its count was not known', async () => {
    await seedMusicFixtures();
    const before = new Date(Date.now() - 86_400_000);
    const albums = getRepository(MusicAlbum);
    await albums.update({ mbId: IDS.otherAlbum }, { mediaAddedAt: before });
    await albums.update(
      { mbId: IDS.album },
      { trackFileCount: null, mediaAddedAt: before }
    );

    await applyLidarr(
      indexOf([
        { mbid: IDS.otherAlbum, trackCount: 12, trackFileCount: 3 },
        { mbid: IDS.album, id: 70, trackCount: 14, trackFileCount: 14 },
      ]),
      { decide: false }
    );
    assert.deepEqual(await addedAt(IDS.otherAlbum), before);
    assert.deepEqual(await addedAt(IDS.album), before);
  });
});
