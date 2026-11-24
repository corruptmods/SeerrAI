import type { SiloCatalogItem } from '@server/api/silo/types';
import { getRepository } from '@server/datasource';
import SiloEpisode from '@server/entity/SiloEpisode';
import type { SeenQuality } from '@server/lib/mediaQuality';
import { combineQuality, siloVersionQuality } from '@server/lib/mediaQuality';
import { isSilo4k } from '@server/lib/silo';
import { In } from 'typeorm';

/*
 * Silo's episodes as the scans last listed them (silo_episode). Silo can't
 * list one series' episodes, so a series' seasons are counted from here.
 */

/** Rows written or deleted per query. */
const CHUNK = 500;

/**
 * A catalog episode as stored, counting only files in `libraries` (the
 * enabled ones); undefined when it isn't an episode Seerr can place.
 */
export const episodeRowOf = (
  item: SiloCatalogItem,
  libraries: Set<string>
): SiloEpisode | undefined => {
  if (
    item.type !== 'episode' ||
    !item.series_id ||
    typeof item.season_number !== 'number' ||
    typeof item.episode_number !== 'number'
  ) {
    return undefined;
  }
  const versions = (item.versions ?? []).filter((version) =>
    libraries.has(version.library_id)
  );
  const libraryIds = (item.library_ids ?? []).filter((id) => libraries.has(id));
  if (!versions.length || !libraryIds.length) {
    return undefined;
  }
  const standardVersions = versions.filter((version) => !isSilo4k(version));
  const uhdVersions = versions.filter(isSilo4k);
  const standard = combineQuality(standardVersions.map(siloVersionQuality));
  const uhd = combineQuality(uhdVersions.map(siloVersionQuality));
  return new SiloEpisode({
    contentId: item.content_id,
    seriesId: item.series_id,
    libraryIds,
    season: item.season_number,
    episode: item.episode_number,
    standard: standardVersions.length > 0,
    uhd: uhdVersions.length > 0,
    quality: standard || uhd ? { standard, uhd } : null,
  });
};

/** Saves these episodes, replacing what was stored for each. */
export const saveEpisodes = async (rows: SiloEpisode[]): Promise<void> => {
  const repository = getRepository(SiloEpisode);
  for (let i = 0; i < rows.length; i += CHUNK) {
    await repository.save(rows.slice(i, i + CHUNK));
  }
};

/** Forgets every stored episode not in `keep` (after a full listing). */
export const keepOnlyEpisodes = async (keep: Set<string>): Promise<number> => {
  const repository = getRepository(SiloEpisode);
  const stored = await repository.find({ select: { contentId: true } });
  const gone = stored
    .map((row) => row.contentId)
    .filter((contentId) => !keep.has(contentId));
  for (let i = 0; i < gone.length; i += CHUNK) {
    await repository.delete({ contentId: In(gone.slice(i, i + CHUNK)) });
  }
  return gone.length;
};

/** Forgets these episodes (Silo no longer has them). */
export const forgetEpisodes = async (contentIds: string[]): Promise<void> => {
  const repository = getRepository(SiloEpisode);
  for (let i = 0; i < contentIds.length; i += CHUNK) {
    await repository.delete({
      contentId: In(contentIds.slice(i, i + CHUNK)),
    });
  }
};

/** A series' stored episodes in the enabled libraries. */
export const episodesOf = async (
  seriesId: string,
  libraries: Set<string>
): Promise<SiloEpisode[]> =>
  (await getRepository(SiloEpisode).find({ where: { seriesId } })).filter(
    (row) => row.libraryIds.some((id) => libraries.has(id))
  );

/** A season's episode counts and what its files are in. */
export interface SeasonCount {
  episodes: number;
  episodes4k: number;
}

/**
 * Episodes per season, by side. With 4K off every episode counts as
 * standard, as for Jellyfin and Emby; with it on, an episode with both kinds
 * of file counts on both sides.
 */
export const countSeasons = (
  rows: SiloEpisode[],
  enable4k: boolean
): {
  seasons: Map<number, SeasonCount>;
  qualities: { standard?: SeenQuality; '4k'?: SeenQuality };
} => {
  const seasons = new Map<number, SeasonCount>();
  const standardSeen: (SeenQuality | undefined)[] = [];
  const uhdSeen: (SeenQuality | undefined)[] = [];
  const counted = new Set<string>();
  for (const row of rows) {
    // One row per episode, even if listed twice.
    const key = `${row.season}:${row.episode}`;
    const count = seasons.get(row.season) ?? { episodes: 0, episodes4k: 0 };
    if (!counted.has(key)) {
      counted.add(key);
      if (!enable4k || row.standard) count.episodes += 1;
      if (enable4k && row.uhd) count.episodes4k += 1;
      seasons.set(row.season, count);
    }
    if (enable4k) {
      standardSeen.push(row.quality?.standard);
      uhdSeen.push(row.quality?.uhd);
    } else {
      standardSeen.push(
        combineQuality([row.quality?.standard, row.quality?.uhd])
      );
    }
  }
  return {
    seasons,
    qualities: {
      standard: combineQuality(standardSeen),
      '4k': enable4k ? combineQuality(uhdSeen) : undefined,
    },
  };
};
