import RadarrAPI from '@server/api/servarr/radarr';
import { MediaType } from '@server/constants/media';
import type Media from '@server/entity/Media';
import { NoArrServerError, removeFromArr } from '@server/lib/arrRemoval';
import type { RadarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

/*
 * Removing a title goes to the server it was sent to, or else the default
 * one.
 */

const radarr = (
  id: number,
  hostname: string,
  isDefault: boolean
): RadarrSettings =>
  ({
    id,
    name: hostname,
    hostname,
    port: 7878,
    apiKey: 'key',
    useSsl: false,
    baseUrl: '',
    is4k: false,
    isDefault,
  }) as RadarrSettings;

const movie = (serviceId: number | null) =>
  ({
    id: 1,
    mediaType: MediaType.MOVIE,
    tmdbId: 10,
    serviceId,
    serviceId4k: null,
  }) as unknown as Media;

let asked: string[] = [];
let saved: RadarrSettings[];

beforeEach(() => {
  asked = [];
  saved = getSettings().radarr;
  getSettings().radarr = [
    radarr(0, 'first.test', false),
    radarr(1, 'second.test', true),
  ];
  // Not in that Radarr: nothing more is asked of it.
  mock.method(
    RadarrAPI.prototype,
    'getMovieByTmdbId',
    async function (this: { axios: { defaults: { baseURL: string } } }) {
      asked.push(new URL(this.axios.defaults.baseURL).hostname);
      return {};
    }
  );
});

afterEach(() => {
  mock.restoreAll();
  getSettings().radarr = saved;
});

describe('removing a title from Radarr', () => {
  it('goes to the server it was sent to, the first one added included', async () => {
    await removeFromArr(movie(0), false);
    assert.deepEqual(asked, ['first.test']);
  });

  it('goes to the default server when it was never sent to one', async () => {
    await removeFromArr(movie(null), false);
    assert.deepEqual(asked, ['second.test']);
  });

  it('goes nowhere when its server has been removed', async () => {
    await assert.rejects(removeFromArr(movie(7), false), NoArrServerError);
    assert.deepEqual(asked, []);
  });
});
