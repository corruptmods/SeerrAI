import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import type { AxiosInstance } from 'axios';

import type {
  RadarrMovie,
  RadarrMovieOptions,
} from '@server/api/servarr/radarr';
import RadarrAPI from '@server/api/servarr/radarr';

function buildRadarr(): RadarrAPI {
  return new RadarrAPI({ url: 'http://localhost:7878/api/v3', apiKey: 'test' });
}

function getAxios(radarr: RadarrAPI): AxiosInstance {
  return (radarr as unknown as { axios: AxiosInstance }).axios;
}

describe('RadarrAPI removeMovie', () => {
  afterEach(() => mock.restoreAll());

  it('removes the movie when it exists in the library', async () => {
    const radarr = buildRadarr();
    mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () => ({
      id: 7,
      title: 'Test Movie',
    }));
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await radarr.removeMovie(550);

    assert.strictEqual(del.mock.callCount(), 1);
    assert.strictEqual(del.mock.calls[0].arguments[0], '/movie/7');
  });

  it('does nothing when the movie is not in the library', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => ({
      data: [{ id: 0, title: 'Fight Club' }],
    }));
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await assert.doesNotReject(() => radarr.removeMovie(550));
    assert.strictEqual(del.mock.callCount(), 0);
  });

  it('rejects when the tmdbId is unknown to the lookup', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => ({ data: [] }));
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await assert.rejects(() => radarr.removeMovie(550), /Movie not found/);
    assert.strictEqual(del.mock.callCount(), 0);
  });

  it('ignores a 404 when the movie was already removed in Radarr', async () => {
    const radarr = buildRadarr();
    mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () => ({
      id: 7,
      title: 'Test Movie',
    }));
    mock.method(getAxios(radarr), 'delete', async () => {
      throw { response: { status: 404 } };
    });

    await assert.doesNotReject(() => radarr.removeMovie(550));
  });

  it('rethrows errors other than 404', async () => {
    const radarr = buildRadarr();
    mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () => ({
      id: 7,
      title: 'Test Movie',
    }));
    mock.method(getAxios(radarr), 'delete', async () => {
      throw { response: { status: 500 } };
    });

    await assert.rejects(() => radarr.removeMovie(550));
  });

  it('rethrows a 404 from the lookup instead of treating it as removed', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => {
      throw { response: { status: 404 } };
    });
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await assert.rejects(
      () => radarr.removeMovie(550),
      (e: unknown) =>
        (e as { response?: { status?: number } }).response?.status === 404
    );
    assert.strictEqual(del.mock.callCount(), 0);
  });
});

describe('RadarrAPI getMovieByTmdbId', () => {
  afterEach(() => mock.restoreAll());

  it('rethrows a 401 from the lookup with the status intact', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => {
      throw { response: { status: 401 } };
    });

    await assert.rejects(
      () => radarr.getMovieByTmdbId(550),
      (e: unknown) =>
        (e as { response?: { status?: number } }).response?.status === 401
    );
  });

  it('throws "Movie not found" when the lookup returns no results', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => ({ data: [] }));

    await assert.rejects(() => radarr.getMovieByTmdbId(550), {
      message: 'Movie not found',
    });
  });
});

/*
 * A request searches straight away only when Radarr says the movie is
 * available, which it works out from the movie's Minimum Availability.
 * Otherwise the movie is added and monitored, and Radarr grabs it once it
 * becomes available.
 */
describe('RadarrAPI addMovie', () => {
  afterEach(() => mock.restoreAll());

  const options: RadarrMovieOptions = {
    title: 'Test Movie',
    qualityProfileId: 1,
    minimumAvailability: 'released',
    tags: [],
    profileId: 1,
    year: 2026,
    rootFolderPath: '/movies',
    tmdbId: 550,
    monitored: true,
    searchNow: true,
  };

  const lookup = (radarr: RadarrAPI, movie: Partial<RadarrMovie>) =>
    mock.method(getAxios(radarr), 'get', async () => ({
      data: [{ title: 'Test Movie', tags: [], ...movie }],
    }));

  const stubSearch = () =>
    mock.method(RadarrAPI.prototype, 'searchMovie', async () => undefined);

  for (const isAvailable of [true, false]) {
    const searches = isAvailable ? 'searches' : 'does not search';
    const state = isAvailable ? 'available' : 'not available yet';

    it(`${searches} for a new movie Radarr reports ${state}`, async () => {
      const radarr = buildRadarr();
      lookup(radarr, { id: 0, monitored: false, hasFile: false });
      const post = mock.method(getAxios(radarr), 'post', async () => ({
        data: { id: 9, title: 'Test Movie', monitored: true, isAvailable },
      }));
      const search = stubSearch();

      await radarr.addMovie(options);

      assert.strictEqual(post.mock.callCount(), 1);
      const body = post.mock.calls[0].arguments[1] as {
        monitored: boolean;
        addOptions: { searchForMovie: boolean };
      };
      assert.strictEqual(body.monitored, true);
      // Radarr would search on its own when adding with this set.
      assert.strictEqual(body.addOptions.searchForMovie, false);
      assert.deepStrictEqual(
        search.mock.calls.map((c) => c.arguments[0]),
        isAvailable ? [9] : []
      );
    });

    it(`${searches} for an unmonitored movie Radarr reports ${state}`, async () => {
      const radarr = buildRadarr();
      lookup(radarr, { id: 7, monitored: false, hasFile: false });
      const put = mock.method(getAxios(radarr), 'put', async () => ({
        data: { id: 7, title: 'Test Movie', monitored: true, isAvailable },
      }));
      const search = stubSearch();

      await radarr.addMovie(options);

      assert.strictEqual(put.mock.callCount(), 1);
      const body = put.mock.calls[0].arguments[1] as {
        addOptions: { searchForMovie: boolean };
      };
      assert.strictEqual(body.addOptions.searchForMovie, false);
      assert.deepStrictEqual(
        search.mock.calls.map((c) => c.arguments[0]),
        isAvailable ? [7] : []
      );
    });

    it(`${searches} for a monitored movie without a file Radarr reports ${state}`, async () => {
      const radarr = buildRadarr();
      lookup(radarr, { id: 7, monitored: true, hasFile: false, isAvailable });
      const search = stubSearch();

      await radarr.addMovie(options);

      assert.deepStrictEqual(
        search.mock.calls.map((c) => c.arguments[0]),
        isAvailable ? [7] : []
      );
    });
  }

  it('searches as before when Radarr does not say whether it is available', async () => {
    const radarr = buildRadarr();
    lookup(radarr, { id: 0, monitored: false, hasFile: false });
    mock.method(getAxios(radarr), 'post', async () => ({
      data: { id: 9, title: 'Test Movie', monitored: true },
    }));
    const search = stubSearch();

    await radarr.addMovie(options);

    assert.deepStrictEqual(
      search.mock.calls.map((c) => c.arguments[0]),
      [9]
    );
  });

  it('does not search when searching is turned off for the server', async () => {
    const radarr = buildRadarr();
    lookup(radarr, { id: 0, monitored: false, hasFile: false });
    mock.method(getAxios(radarr), 'post', async () => ({
      data: { id: 9, title: 'Test Movie', monitored: true, isAvailable: true },
    }));
    const search = stubSearch();

    await radarr.addMovie({ ...options, searchNow: false });

    assert.strictEqual(search.mock.callCount(), 0);
  });
});
