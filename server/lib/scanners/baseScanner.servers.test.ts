import { MediaStatus, MediaType } from '@server/constants/media';
import type { MediaServerKind } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import BaseScanner from '@server/lib/scanners/baseScanner';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

setupTestDb();

/*
 * Scans from more than one media server (and from Radarr and Sonarr) on
 * the same titles: each writes only its own server's ids, and two finding a
 * title at once add it once.
 */

class ProbeScanner extends BaseScanner<unknown> {
  constructor(name: string) {
    super(name, {});
  }

  public begin() {
    return this.startRun();
  }

  public seeMovie(tmdbId: number, mediaServer?: MediaServerKind, id?: string) {
    return this.processMovie(tmdbId, {
      mediaServer,
      itemId: id,
      title: `Movie ${tmdbId}`,
    });
  }

  public seeShow(
    tmdbId: number,
    mediaServer?: MediaServerKind,
    id?: string,
    episodes = 8
  ) {
    return this.processShow(
      tmdbId,
      undefined,
      [{ seasonNumber: 1, totalEpisodes: 8, episodes, episodes4k: 0 }],
      { mediaServer, itemId: id, title: `Show ${tmdbId}` }
    );
  }
}

const scanners = () => {
  const plex = new ProbeScanner('Plex Probe');
  const jellyfin = new ProbeScanner('Jellyfin Probe');
  const emby = new ProbeScanner('Emby Probe');
  const sonarr = new ProbeScanner('Sonarr Probe');
  for (const scanner of [plex, jellyfin, emby, sonarr]) scanner.begin();
  return { plex, jellyfin, emby, sonarr };
};

describe('scans from several media servers', () => {
  it('adds a title found by two scans at the same moment once', async () => {
    const { plex, jellyfin, emby } = scanners();
    await Promise.all([
      plex.seeMovie(603, 'plex', 'p-603'),
      jellyfin.seeMovie(603, 'jellyfin', 'j-603'),
      emby.seeMovie(603, 'emby', 'e-603'),
    ]);
    const rows = await getRepository(Media).find({
      where: { tmdbId: 603, mediaType: MediaType.MOVIE },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ratingKey, 'p-603');
    assert.equal(rows[0].jellyfinMediaId, 'j-603');
    assert.equal(rows[0].embyMediaId, 'e-603');
    assert.equal(rows[0].status, MediaStatus.AVAILABLE);
  });

  it("keeps each server's id on a series the others scan", async () => {
    const { plex, jellyfin, emby, sonarr } = scanners();
    await plex.seeShow(1396, 'plex', 'p-1396');
    await jellyfin.seeShow(1396, 'jellyfin', 'j-1396');
    await emby.seeShow(1396, 'emby', 'e-1396');
    // Sonarr has no media server id at all.
    await sonarr.seeShow(1396);
    // Nor does a server whose item has no episodes yet.
    await jellyfin.seeShow(1396, 'jellyfin', 'j-other', 0);

    const show = await getRepository(Media).findOneOrFail({
      where: { tmdbId: 1396, mediaType: MediaType.TV },
    });
    assert.equal(show.ratingKey, 'p-1396');
    assert.equal(show.jellyfinMediaId, 'j-1396');
    assert.equal(show.embyMediaId, 'e-1396');
  });

  it("writes Emby's ids to Emby's own columns", async () => {
    const { emby } = scanners();
    await emby.seeMovie(27205, 'emby', 'e-27205');
    const movie = await getRepository(Media).findOneOrFail({
      where: { tmdbId: 27205, mediaType: MediaType.MOVIE },
    });
    assert.equal(movie.embyMediaId, 'e-27205');
    assert.equal(movie.jellyfinMediaId, null);
    assert.equal(movie.ratingKey, null);
  });

  it('takes an item from the title it left on that server only', async () => {
    const { jellyfin, emby } = scanners();
    await jellyfin.seeMovie(100, 'jellyfin', 'shared-id');
    await emby.seeMovie(100, 'emby', 'item-1');
    // Emby re-matched its item to another film; Jellyfin did not.
    await emby.seeMovie(200, 'emby', 'item-1');

    const left = await getRepository(Media).findOneOrFail({
      where: { tmdbId: 100, mediaType: MediaType.MOVIE },
    });
    assert.equal(left.embyMediaId, null);
    assert.equal(left.jellyfinMediaId, 'shared-id');
    const found = await getRepository(Media).findOneOrFail({
      where: { tmdbId: 200, mediaType: MediaType.MOVIE },
    });
    assert.equal(found.embyMediaId, 'item-1');
  });
});
