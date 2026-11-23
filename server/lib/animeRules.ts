import { ANIME_KEYWORD_ID } from '@server/api/themoviedb/constants';
import { getRepository } from '@server/datasource';
import OverrideRule from '@server/entity/OverrideRule';
import { animeRulesSetUp, setAnimeRulesSetUp } from '@server/lib/settings';
import logger from '@server/logger';
import type { EntityManager } from 'typeorm';

/**
 * Whether an override rule routes anime: it names TMDB's anime keyword, or
 * sets the anime series type. Either counts for auto anime handling
 * (Settings → Services → Anime), as servers' anime libraries do.
 */
export const routesAnime = (
  rule: Pick<OverrideRule, 'keywords' | 'seriesType'>
): boolean =>
  rule.seriesType === 'anime' ||
  !!rule.keywords
    ?.split(',')
    .some((keyword) => Number(keyword) === ANIME_KEYWORD_ID);

/**
 * Reads the override rules again for Settings.animeOn, which stays
 * synchronous. Run at startup and after every rule written
 * (OverrideRuleSubscriber); `manager` is the writer's, so a write inside a
 * transaction is seen.
 */
export const refreshAnimeRules = async (
  manager?: EntityManager
): Promise<boolean> => {
  const repository = manager
    ? manager.getRepository(OverrideRule)
    : getRepository(OverrideRule);
  try {
    const rules = await repository.find({
      select: { id: true, keywords: true, seriesType: true },
    });
    const found = rules.some(routesAnime);
    setAnimeRulesSetUp(found);
    return found;
  } catch (e) {
    // Keep what was known: a failed read shouldn't switch anime off.
    logger.warn('Could not read override rules for anime handling', {
      label: 'Anime',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return animeRulesSetUp();
  }
};
