import type { SonarrSeries } from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Episode from '@server/entity/Episode';
import Media from '@server/entity/Media';
import Season from '@server/entity/Season';
import episodeSync from '@server/lib/episodeSync';
import type { SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/*
 * Episode Sync reads Sonarr's series list once a pass, and a series' episodes
 * only when its counts there have moved since it was last synced.
 */

setupTestDb();

let series: SonarrSeries[] = [];
let episodeCalls: number[] = [];
let failing = new Set<number>();
const episodesOf: Record<
  number,
  { seasonNumber: number; episodeNumber: number; hasFile: boolean }[]
> = {};

Object.defineProperty(SonarrAPI.prototype, 'getSeries', {
  configurable: true,
  writable: true,
  value: async () => series,
});
Object.defineProperty(SonarrAPI.prototype, 'getEpisodes', {
  configurable: true,
  writable: true,
  value: async (id: number) => {
    episodeCalls.push(id);
    if (failing.has(id)) {
      throw new Error('Sonarr fell over');
    }
    return episodesOf[id] ?? [];
  },
});

const seriesWith = (id: number, files: number, episodes = 3) =>
  ({
    id,
    title: `Series ${id}`,
    seasons: [
      {
        seasonNumber: 1,
        monitored: true,
        statistics: {
          episodeFileCount: files,
          episodeCount: episodes,
          totalEpisodeCount: episodes,
          sizeOnDisk: 0,
          percentOfEpisodes: 0,
        },
      },
    ],
  }) as unknown as SonarrSeries;

const show = async (tmdbId: number, sonarrId: number) => {
  const media = await getRepository(Media).save(
    new Media({
      tmdbId,
      mediaType: MediaType.TV,
      status: MediaStatus.PARTIALLY_AVAILABLE,
      serviceId: 0,
      externalServiceId: sonarrId,
    })
  );
  await getRepository(Season).save(
    new Season({
      seasonNumber: 1,
      status: MediaStatus.PARTIALLY_AVAILABLE,
      media: Promise.resolve(media),
    } as never)
  );
  return media;
};

const availableOf = async (media: Media) =>
  getRepository(Episode).count({
    where: {
      season: { media: { id: media.id } },
      status: MediaStatus.AVAILABLE,
    },
  });

beforeEach(() => {
  getSettings().sonarr = [
    {
      id: 0,
      name: 'Sonarr',
      hostname: '127.0.0.1',
      port: 8989,
      apiKey: 'k',
      useSsl: false,
      is4k: false,
      isDefault: true,
    } as SonarrSettings,
  ];
  episodeCalls = [];
  failing = new Set();
  Reflect.set(episodeSync, 'synced', new Map());
});

const files = (count: number) =>
  [1, 2, 3].map((episodeNumber) => ({
    seasonNumber: 1,
    episodeNumber,
    hasFile: episodeNumber <= count,
  }));

describe('Episode Sync', () => {
  it('reads a series once, then again only when its counts move', async () => {
    const media = await show(70001, 501);
    series = [seriesWith(501, 1)];
    episodesOf[501] = files(1);

    await episodeSync.run();
    await episodeSync.run();
    assert.deepEqual(episodeCalls, [501], 'unchanged: not read again');
    assert.equal(await availableOf(media), 1);

    series = [seriesWith(501, 2)];
    episodesOf[501] = files(2);
    await episodeSync.run();
    assert.deepEqual(episodeCalls, [501, 501]);
    assert.equal(await availableOf(media), 2);
  });

  it('skips a series that is no longer in Sonarr, quietly', async () => {
    await show(70002, 502);
    series = [];

    await episodeSync.run();
    assert.deepEqual(episodeCalls, []);
  });

  it('carries on past a series that fails, and tries it again next pass', async () => {
    const broken = await show(70003, 503);
    const fine = await show(70004, 504);
    series = [seriesWith(503, 1), seriesWith(504, 3)];
    episodesOf[503] = files(1);
    episodesOf[504] = files(3);
    failing.add(503);

    await episodeSync.run();
    assert.equal(await availableOf(fine), 3, 'the next show still synced');
    assert.equal(await availableOf(broken), 0);

    failing.delete(503);
    await episodeSync.run();
    assert.equal(await availableOf(broken), 1, 'retried, as it never synced');
  });

  it('reads a just-requested show again once its season rows exist', async () => {
    // Requested a moment ago: Sonarr already has files, but the scan that
    // adds the show's season rows has not run yet.
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 70005,
        mediaType: MediaType.TV,
        status: MediaStatus.PROCESSING,
        serviceId: 0,
        externalServiceId: 505,
      })
    );
    series = [seriesWith(505, 3)];
    episodesOf[505] = files(3);

    await episodeSync.run();
    assert.equal(await availableOf(media), 0, 'nowhere to keep them yet');

    await getRepository(Season).save(
      new Season({
        seasonNumber: 1,
        status: MediaStatus.PARTIALLY_AVAILABLE,
        media: Promise.resolve(media),
      } as never)
    );
    // Sonarr's counts have not moved since: it is still read, as it was
    // never stored.
    await episodeSync.run();
    assert.deepEqual(episodeCalls, [505, 505]);
    assert.equal(await availableOf(media), 3);
  });
});
