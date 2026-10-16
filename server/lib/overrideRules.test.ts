import type {
  TmdbMovieDetails,
  TmdbTvDetails,
} from '@server/api/themoviedb/interfaces';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import OverrideRule from '@server/entity/OverrideRule';
import { User } from '@server/entity/User';
import overrideRules, { titleCertification } from '@server/lib/overrideRules';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

/*
 * Override rules that match on a title's age rating: read from TMDB for the
 * server's Discover region, or the US rating when the title has none there.
 * And rules that name TMDB's anime keyword, which go by whether Seerr
 * decides the title is anime rather than by the keyword itself.
 */

setupTestDb();

const settings = getSettings();
const saved = {
  radarr: settings.radarr,
  sonarr: settings.sonarr,
  region: settings.main.discoverRegion,
  leaveOut: settings.main.animeExcludedCountries,
};

after(() => {
  settings.radarr = saved.radarr;
  settings.sonarr = saved.sonarr;
  settings.main.discoverRegion = saved.region;
  settings.main.animeExcludedCountries = saved.leaveOut;
});

/** A film rated as given, by country; an empty rating is TMDB's "none". */
const film = (ratings: Record<string, string[]>) =>
  ({
    id: 1,
    genres: [],
    original_language: 'en',
    keywords: { keywords: [] },
    release_dates: {
      results: Object.entries(ratings).map(([iso_3166_1, certs]) => ({
        iso_3166_1,
        release_dates: certs.map((certification, i) => ({
          certification,
          release_date: '2020-01-01T00:00:00.000Z',
          type: i + 3,
        })),
      })),
    },
  }) as unknown as TmdbMovieDetails;

const series = (ratings: Record<string, string>) =>
  ({
    id: 2,
    genres: [],
    original_language: 'en',
    keywords: { results: [] },
    content_ratings: {
      results: Object.entries(ratings).map(([iso_3166_1, rating]) => ({
        iso_3166_1,
        rating,
      })),
    },
  }) as unknown as TmdbTvDetails;

let requester: User;

const rule = (init: Partial<OverrideRule>) =>
  getRepository(OverrideRule).save(new OverrideRule(init));

const movieFolder = async (tmdbMedia: TmdbMovieDetails) =>
  (
    await overrideRules({
      mediaType: MediaType.MOVIE,
      is4k: false,
      tmdbMedia,
      requestUser: requester,
      serviceId: 0,
    })
  ).rootFolder;

beforeEach(async () => {
  settings.main.discoverRegion = '';
  settings.main.animeExcludedCountries = [];
  settings.radarr = [{ id: 0, isDefault: true, is4k: false } as RadarrSettings];
  settings.sonarr = [{ id: 0, isDefault: true, is4k: false } as SonarrSettings];
  requester = await getRepository(User).findOneOrFail({
    where: { email: 'friend@seerr.dev' },
  });
});

describe('an override rule on age ratings', () => {
  it('sends a film rated as the rule says where the rule says', async () => {
    await rule({
      radarrServiceId: 0,
      certification: 'US:G,US:PG',
      rootFolder: '/kids',
    });

    assert.equal(await movieFolder(film({ US: ['PG'] })), '/kids');
    assert.equal(await movieFolder(film({ US: ['R'] })), null);
  });

  it("reads the film's rating as its page does: the first one given", async () => {
    await rule({
      radarrServiceId: 0,
      certification: 'US:PG',
      rootFolder: '/kids',
    });

    assert.equal(await movieFolder(film({ US: ['', 'PG', 'R'] })), '/kids');
    assert.equal(await movieFolder(film({ US: ['', 'R', 'PG'] })), null);
  });

  it("goes by the server's Discover region", async () => {
    settings.main.discoverRegion = 'GB';
    await rule({
      radarrServiceId: 0,
      certification: 'GB:12A',
      rootFolder: '/teens',
    });
    await rule({
      radarrServiceId: 0,
      certification: 'US:PG-13',
      rootFolder: '/us-teens',
    });

    assert.equal(
      await movieFolder(film({ GB: ['12A'], US: ['PG-13'] })),
      '/teens'
    );
    // Rated in the region, so its US rating is not looked at.
    assert.equal(await movieFolder(film({ GB: ['15'], US: ['PG-13'] })), null);
  });

  it('falls back to the US rating when the region has none', async () => {
    settings.main.discoverRegion = 'GB';
    await rule({
      radarrServiceId: 0,
      certification: 'GB:PG,US:PG',
      rootFolder: '/kids',
    });

    assert.equal(await movieFolder(film({ GB: [''], US: ['PG'] })), '/kids');
    assert.equal(await movieFolder(film({ US: ['PG'] })), '/kids');
  });

  it('matches a rating only in its own country', async () => {
    settings.main.discoverRegion = 'GB';
    await rule({
      radarrServiceId: 0,
      certification: 'GB:PG',
      rootFolder: '/kids',
    });

    // "PG" in the US is not the British PG.
    assert.equal(await movieFolder(film({ US: ['PG'] })), null);
  });

  it('never matches a title with no rating at all', async () => {
    await rule({
      radarrServiceId: 0,
      certification: 'US:NR',
      rootFolder: '/unrated',
    });

    assert.equal(await movieFolder(film({})), null);
    assert.equal(await movieFolder(film({ US: [''] })), null);
  });

  it('matches a series by its content rating', async () => {
    await rule({
      sonarrServiceId: 0,
      certification: 'US:TV-Y,US:TV-Y7',
      rootFolder: '/kids-tv',
    });

    const folderFor = async (tmdbMedia: TmdbTvDetails) =>
      (
        await overrideRules({
          mediaType: MediaType.TV,
          is4k: false,
          tmdbMedia,
          requestUser: requester,
          serviceId: 0,
        })
      ).rootFolder;

    assert.equal(await folderFor(series({ US: 'TV-Y7' })), '/kids-tv');
    assert.equal(await folderFor(series({ US: 'TV-MA' })), null);
  });

  it('needs every other condition of the rule to match too', async () => {
    await rule({
      radarrServiceId: 0,
      certification: 'US:PG',
      genre: '16',
      rootFolder: '/kids-animation',
    });

    assert.equal(await movieFolder(film({ US: ['PG'] })), null);
    assert.equal(
      await movieFolder({
        ...film({ US: ['PG'] }),
        genres: [{ id: 16, name: 'Animation' }],
      }),
      '/kids-animation'
    );
  });

  it('counts as a condition when choosing the most specific rule', async () => {
    await rule({
      radarrServiceId: 0,
      users: String(requester.id),
      rootFolder: '/friend',
    });
    await rule({
      radarrServiceId: 0,
      users: String(requester.id),
      certification: 'US:G',
      rootFolder: '/friend-kids',
    });

    assert.equal(await movieFolder(film({ US: ['G'] })), '/friend-kids');
    assert.equal(await movieFolder(film({ US: ['R'] })), '/friend');
  });
});

describe("a title's age rating", () => {
  it('is read for the region asked, or else the US', () => {
    const both = film({ DE: ['12'], US: ['PG-13'] });

    assert.deepEqual(titleCertification(both, 'DE'), {
      country: 'DE',
      certification: '12',
    });
    assert.deepEqual(titleCertification(both, 'FR'), {
      country: 'US',
      certification: 'PG-13',
    });
    assert.equal(titleCertification(film({ DE: ['12'] }), 'FR'), undefined);
  });
});

describe("an override rule naming TMDB's anime keyword", () => {
  const ANIME_KEYWORD = { id: 210024, name: 'anime' };
  const ANIMATION = { id: 16, name: 'Animation' };

  /** A series as TMDB describes it. */
  const show = (init: Partial<TmdbTvDetails>) =>
    ({
      id: 3,
      genres: [],
      original_language: 'en',
      origin_country: ['US'],
      keywords: { results: [] },
      ...init,
    }) as unknown as TmdbTvDetails;

  const folderFor = async (
    tmdbMedia: TmdbTvDetails,
    animeSetting: boolean | null = null
  ) =>
    (
      await overrideRules({
        mediaType: MediaType.TV,
        is4k: false,
        tmdbMedia,
        requestUser: requester,
        serviceId: 0,
        animeSetting,
      })
    ).rootFolder;

  beforeEach(async () => {
    await rule({
      sonarrServiceId: 0,
      keywords: '210024',
      rootFolder: '/anime-rule',
    });
    await rule({
      sonarrServiceId: 0,
      genre: '16',
      rootFolder: '/cartoons',
    });
  });

  it('takes anime TMDB tags as anime', async () => {
    assert.equal(
      await folderFor(
        show({
          original_language: 'ja',
          origin_country: ['JP'],
          keywords: { results: [ANIME_KEYWORD] },
        })
      ),
      '/anime-rule'
    );
  });

  it('takes Japanese animation without the keyword as anime too', async () => {
    assert.equal(
      await folderFor(
        show({
          genres: [ANIMATION],
          original_language: 'ja',
          origin_country: ['JP'],
        })
      ),
      '/anime-rule'
    );
  });

  it('takes a title set as anime as anime, keyword or not', async () => {
    assert.equal(
      await folderFor(show({ genres: [ANIMATION] }), true),
      '/anime-rule'
    );
  });

  it('leaves out a title set as not anime, though TMDB tags it', async () => {
    assert.equal(
      await folderFor(
        show({ genres: [ANIMATION], keywords: { results: [ANIME_KEYWORD] } }),
        false
      ),
      '/cartoons'
    );
  });

  it('leaves out anime from a country the server leaves out', async () => {
    settings.main.animeExcludedCountries = ['US'];
    assert.equal(
      await folderFor(
        show({ genres: [ANIMATION], keywords: { results: [ANIME_KEYWORD] } })
      ),
      '/cartoons'
    );
  });

  it('still matches on its other keywords for anything else', async () => {
    await rule({
      sonarrServiceId: 0,
      keywords: '210024,9951',
      rootFolder: '/anime-or-mecha',
    });
    assert.equal(
      await folderFor(
        show({ keywords: { results: [{ id: 9951, name: 'mecha' }] } })
      ),
      '/anime-or-mecha'
    );
  });

  it('goes by the decision for a movie on a server without anime settings', async () => {
    await rule({
      radarrServiceId: 0,
      keywords: '210024',
      rootFolder: '/anime-movies',
    });
    const japanese = {
      ...film({}),
      genres: [ANIMATION],
      original_language: 'ja',
    } as TmdbMovieDetails;
    assert.equal(await movieFolder(japanese), '/anime-movies');
    assert.equal(
      await movieFolder({
        ...film({}),
        production_countries: [{ iso_3166_1: 'US', name: 'United States' }],
        keywords: { keywords: [ANIME_KEYWORD] },
      } as TmdbMovieDetails),
      '/anime-movies'
    );
    settings.main.animeExcludedCountries = ['US'];
    assert.equal(
      await movieFolder({
        ...film({}),
        production_countries: [{ iso_3166_1: 'US', name: 'United States' }],
        keywords: { keywords: [ANIME_KEYWORD] },
      } as TmdbMovieDetails),
      null
    );
  });
});
