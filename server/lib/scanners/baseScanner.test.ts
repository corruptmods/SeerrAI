import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import type Season from '@server/entity/Season';
import downloadTracker from '@server/lib/downloadtracker';
import BaseScanner from '@server/lib/scanners/baseScanner';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

setupTestDb();

/*
 * What a media server scan does to titles beyond the one it finds: the
 * title a re-matched item leaves no longer has it, and downloads shown as
 * "being added" stop showing once the media server lists the title.
 */

class ProbeScanner extends BaseScanner<unknown> {
  constructor() {
    super('Probe Scanner', {});
  }

  public begin() {
    return this.startRun();
  }

  public seeShow(tmdbId: number, ratingKey: string) {
    return this.processShow(
      tmdbId,
      undefined,
      [{ seasonNumber: 1, totalEpisodes: 8, episodes: 7, episodes4k: 0 }],
      { ratingKey, title: `Show ${tmdbId}` }
    );
  }

  public seeMovie(tmdbId: number, ratingKey: string) {
    return this.processMovie(tmdbId, { ratingKey, title: `Movie ${tmdbId}` });
  }
}

describe('a media server scan', () => {
  it('takes an item away from the title it was wrongly matched to', async () => {
    const scanner = new ProbeScanner();
    scanner.begin();
    // Plex first took the new "Wrenna" for "The Wrenna Diaries".
    await scanner.seeShow(57284, '126741');
    const wrong = await getRepository(Media).findOneOrFail({
      where: { tmdbId: 57284, mediaType: MediaType.TV },
      relations: { seasons: true },
    });
    assert.equal(wrong.status, MediaStatus.PARTIALLY_AVAILABLE);

    // Corrected, the same item is now Wrenna (2026), which Sonarr has.
    await getRepository(Media).save(
      new Media({
        tmdbId: 375182,
        mediaType: MediaType.TV,
        status: MediaStatus.PROCESSING,
        serviceId: 0,
        externalServiceId: 1286,
      })
    );
    await scanner.seeShow(375182, '126741');

    const right = await getRepository(Media).findOneOrFail({
      where: { tmdbId: 375182, mediaType: MediaType.TV },
    });
    assert.equal(right.ratingKey, '126741');
    assert.equal(right.status, MediaStatus.PARTIALLY_AVAILABLE);
    const left = await getRepository(Media).findOneOrFail({
      where: { tmdbId: 57284, mediaType: MediaType.TV },
      relations: { seasons: true },
    });
    assert.equal(left.ratingKey, null);
    assert.equal(left.status, MediaStatus.UNKNOWN);
    assert.deepEqual(
      left.seasons.map((s: Season) => s.status),
      [MediaStatus.UNKNOWN]
    );
  });

  it('leaves a title Radarr has to the availability sync', async () => {
    const scanner = new ProbeScanner();
    scanner.begin();
    await getRepository(Media).save(
      new Media({
        tmdbId: 9001,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
        ratingKey: '555',
        serviceId: 0,
        externalServiceId: 77,
      })
    );
    await scanner.seeMovie(9002, '555');
    const other = await getRepository(Media).findOneOrFail({
      where: { tmdbId: 9001, mediaType: MediaType.MOVIE },
    });
    assert.equal(other.ratingKey, null);
    assert.equal(other.status, MediaStatus.AVAILABLE);
  });

  it('leaves a title another server still has as it is', async () => {
    const scanner = new ProbeScanner();
    scanner.begin();
    await getRepository(Media).save(
      new Media({
        tmdbId: 9011,
        mediaType: MediaType.TV,
        status: MediaStatus.AVAILABLE,
        ratingKey: '556',
        jellyfinMediaId: 'jf-9011',
        seasons: [],
      })
    );
    // Plex's item is now another show; Jellyfin still has this one.
    await scanner.seeShow(9012, '556');
    const other = await getRepository(Media).findOneOrFail({
      where: { tmdbId: 9011, mediaType: MediaType.TV },
    });
    assert.equal(other.ratingKey, null);
    assert.equal(other.jellyfinMediaId, 'jf-9011');
    assert.equal(other.status, MediaStatus.AVAILABLE);
  });

  it('stops showing imported downloads for a title it lists', async () => {
    const forget = mock.method(downloadTracker, 'forgetImported');
    await getRepository(Media).save(
      new Media({
        tmdbId: 9100,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PROCESSING,
        serviceId: 0,
        externalServiceId: 31,
      })
    );
    const scanner = new ProbeScanner();
    scanner.begin();
    await scanner.seeMovie(9100, '9100');
    assert.deepEqual(
      forget.mock.calls.map((c) => c.arguments.slice(0, 3)),
      [['movie', 0, 31]]
    );
    forget.mock.restore();
  });
});
