import { ANIME_KEYWORD_ID } from '@server/api/themoviedb/constants';
import type {
  TmdbKeyword,
  TmdbMovieDetails,
  TmdbTvDetails,
} from '@server/api/themoviedb/interfaces';
import { MediaType } from '@server/constants/media';
import type { SeriesType } from '@server/constants/seriesType';
import { toSeriesTypeFor } from '@server/constants/seriesType';
import { getRepository } from '@server/datasource';
import OverrideRule from '@server/entity/OverrideRule';
import type { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
import { isAnime } from '@server/utils/isAnime';
import type { RuleCertification } from '@server/utils/ruleCertification';
import { parseRuleCertifications } from '@server/utils/ruleCertification';

/**
 * A title's age rating, read as its page reads it: TMDB's rating for the
 * region (for a film, the first of its releases there that has one), or
 * else its US rating. Undefined when it has neither.
 */
export const titleCertification = (
  tmdbMedia: TmdbMovieDetails | TmdbTvDetails,
  region: string
): RuleCertification | undefined => {
  const ratingIn = (country: string) =>
    'release_dates' in tmdbMedia
      ? tmdbMedia.release_dates?.results
          ?.find((r) => r.iso_3166_1 === country)
          ?.release_dates.find((release) => release.certification?.trim())
          ?.certification.trim()
      : tmdbMedia.content_ratings?.results
          ?.find((r) => r.iso_3166_1 === country)
          ?.rating?.trim();

  for (const country of new Set([region, 'US'])) {
    const certification = ratingIn(country);
    if (certification) {
      return { country, certification };
    }
  }

  return undefined;
};

export type OverrideRulesResult = {
  rootFolder: string | null;
  profileId: number | null;
  tags: number[] | null;
  /** For a movie, only 'anime' or 'standard'. */
  seriesType: SeriesType | null;
};

async function overrideRules({
  mediaType,
  is4k,
  tmdbMedia,
  requestUser,
  tags = null,
  serviceId,
  animeSetting = null,
}: {
  mediaType: MediaType;
  is4k: boolean;
  tmdbMedia: TmdbMovieDetails | TmdbTvDetails;
  requestUser: User;
  tags?: number[] | null;
  serviceId?: number;
  /** The title's own anime setting (Media.animeSetting), if it has one. */
  animeSetting?: boolean | null;
}): Promise<OverrideRulesResult> {
  const settings = getSettings();

  let rootFolder: string | null = null;
  let profileId: number | null = null;
  let seriesType: SeriesType | null = null;

  const serviceIdField =
    mediaType === MediaType.MOVIE ? 'radarrServiceId' : 'sonarrServiceId';
  if (serviceId === undefined) {
    const defaultRadarrId = is4k
      ? settings.radarr.find((r) => r.is4k && r.isDefault)?.id
      : settings.radarr.find((r) => !r.is4k && r.isDefault)?.id;
    const defaultSonarrId = is4k
      ? settings.sonarr.find((s) => s.is4k && s.isDefault)?.id
      : settings.sonarr.find((s) => !s.is4k && s.isDefault)?.id;
    serviceId =
      mediaType === MediaType.MOVIE ? defaultRadarrId : defaultSonarrId;
  }

  const overrideRuleRepository = getRepository(OverrideRule);
  const rules =
    serviceId === undefined
      ? []
      : await overrideRuleRepository.find({
          where: { [serviceIdField]: serviceId },
        });

  // Anime movies too, once their Radarr server has an anime folder or
  // profile of its own; until then rules apply to them as to any movie.
  const radarrServer =
    mediaType === MediaType.MOVIE
      ? settings.radarr.find((r) => r.id === serviceId)
      : undefined;
  const animeSettings =
    mediaType === MediaType.TV ||
    !!radarrServer?.activeAnimeDirectory ||
    !!radarrServer?.activeAnimeProfileId;
  const anime = animeSettings && (animeSetting ?? isAnime(tmdbMedia));

  // Read for the server's Discover region, as the title's page reads it for
  // anyone who has not chosen a region of their own.
  const certification = rules.some((rule) => rule.certification)
    ? titleCertification(tmdbMedia, settings.main.discoverRegion || 'US')
    : undefined;

  const appliedOverrideRules = rules.filter((rule) => {
    // Anime goes by the anime settings, unless a rule names the anime
    // keyword to take it over. Anime is told by the title's own setting, or
    // else the same test as routing (utils/isAnime), so a title without the
    // keyword is treated alike.
    if (
      anime &&
      (!rule.keywords ||
        !rule.keywords.split(',').map(Number).includes(ANIME_KEYWORD_ID))
    ) {
      return false;
    }

    if (
      rule.users &&
      !rule.users.split(',').some((userId) => Number(userId) === requestUser.id)
    ) {
      return false;
    }
    if (
      rule.genre &&
      !rule.genre
        .split(',')
        .some((genreId) =>
          tmdbMedia.genres.map((genre) => genre.id).includes(Number(genreId))
        )
    ) {
      return false;
    }
    if (
      rule.language &&
      !rule.language
        .split('|')
        .some((languageId) => languageId === tmdbMedia.original_language)
    ) {
      return false;
    }
    if (
      rule.keywords &&
      !rule.keywords.split(',').some((keywordId) => {
        let keywordList: TmdbKeyword[] = [];

        if ('keywords' in tmdbMedia.keywords) {
          keywordList = tmdbMedia.keywords.keywords;
        } else if ('results' in tmdbMedia.keywords) {
          keywordList = tmdbMedia.keywords.results;
        }

        return keywordList
          .map((keyword: TmdbKeyword) => keyword.id)
          .includes(Number(keywordId));
      })
    ) {
      return false;
    }
    // A rating is only the same rating in the same country's system: "PG"
    // in the US is not the British "PG". A title without one never matches.
    if (
      rule.certification &&
      !parseRuleCertifications(rule.certification).some(
        (entry) =>
          entry.country === certification?.country &&
          entry.certification === certification.certification
      )
    ) {
      return false;
    }
    return true;
  });

  // hacky way to prioritize rules
  // TODO: make this better
  const hasSpecificOverrideValue = (
    rule: OverrideRule,
    key: keyof OverrideRule
  ) => {
    const value = rule[key];
    if (value == null) return false;
    return typeof value !== 'string' || value.trim() !== '';
  };
  const prioritizedRule = appliedOverrideRules.sort((a, b) => {
    const keys: (keyof OverrideRule)[] = [
      'genre',
      'language',
      'keywords',
      'certification',
    ];
    const aSpecificity = keys.filter((key) =>
      hasSpecificOverrideValue(a, key)
    ).length;
    const bSpecificity = keys.filter((key) =>
      hasSpecificOverrideValue(b, key)
    ).length;
    // Take the rule with the most specific condition first
    return bSpecificity - aSpecificity;
  })[0];

  if (prioritizedRule) {
    if (prioritizedRule.rootFolder) {
      rootFolder = prioritizedRule.rootFolder;
    }
    if (prioritizedRule.profileId) {
      profileId = prioritizedRule.profileId;
    }
    seriesType = toSeriesTypeFor(mediaType, prioritizedRule.seriesType);
    if (prioritizedRule.tags) {
      tags = [
        ...new Set([
          ...(tags || []),
          ...prioritizedRule.tags.split(',').map((tag) => Number(tag)),
        ]),
      ];
    }
  }

  return { rootFolder, profileId, tags, seriesType };
}

export default overrideRules;
