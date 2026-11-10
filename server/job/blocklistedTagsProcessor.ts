import {
  MovieSortOptionsIterable,
  TvSortOptionsIterable,
} from '@server/api/themoviedb';
import type {
  TmdbSearchMovieResponse,
  TmdbSearchTvResponse,
} from '@server/api/themoviedb/interfaces';
import type { VideoMediaType } from '@server/constants/media';
import {
  MediaStatus,
  MediaType,
  VIDEO_MEDIA_TYPES,
} from '@server/constants/media';
import dataSource from '@server/datasource';
import { Blocklist } from '@server/entity/Blocklist';
import Media from '@server/entity/Media';
import type {
  RunnableScanner,
  StatusBase,
} from '@server/lib/scanners/baseScanner';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { createTmdbWithBlocklistSettings } from '@server/routes/discover';
import type { EntityManager } from 'typeorm';
import { In } from 'typeorm';

const TMDB_API_DELAY_MS = 250;
class AbortTransaction extends Error {}

const keyOf = (mediaType: string, tmdbId: number) => `${mediaType}:${tmdbId}`;

/** Already in the library: tags only keep new titles out. */
const IN_LIBRARY = [MediaStatus.AVAILABLE, MediaStatus.PARTIALLY_AVAILABLE];

class BlocklistedTagProcessor implements RunnableScanner<StatusBase> {
  private running = false;
  private progress = 0;
  private total = 0;
  /** Titles this run found under each tag, by keyOf. */
  private found = new Map<string, Set<string>>();
  /** A TMDB lookup failed, so not finding a title proves nothing. */
  private incomplete = false;

  public async run() {
    this.running = true;
    this.found = new Map();
    this.incomplete = false;

    try {
      // Titles still matched keep their rows; only entries no tag matches
      // any more are removed, so titles aren't recreated (and shown as newly
      // added) on every run.
      await dataSource.transaction(async (em) => {
        await this.createBlocklistEntries(em);
        await this.cleanBlocklist(em);
      });
    } catch (err) {
      if (err instanceof AbortTransaction) {
        logger.info('Aborting job: Process Blocklisted Tags', {
          label: 'Jobs',
        });
      } else {
        throw err;
      }
    } finally {
      this.reset();
    }
  }

  public status(): StatusBase {
    return {
      running: this.running,
      progress: this.progress,
      total: this.total,
    };
  }

  public cancel() {
    this.running = false;
    this.progress = 0;
    this.total = 0;
  }

  private reset() {
    this.cancel();
  }

  private async createBlocklistEntries(em: EntityManager) {
    const tmdb = createTmdbWithBlocklistSettings();

    const settings = getSettings();
    const blocklistedTags = settings.main.blocklistedTags;
    const blocklistedTagsArr = blocklistedTags.split(',');

    const pageLimit = settings.main.blocklistedTagsLimit;
    const invalidKeywords = new Set<string>();

    if (blocklistedTags.length === 0) {
      return;
    }

    // The maximum number of queries expected.
    this.total =
      blocklistedTagsArr.length *
      pageLimit *
      (MovieSortOptionsIterable.length + TvSortOptionsIterable.length);

    for (const tag of blocklistedTagsArr) {
      const keywordDetails = await tmdb.getKeywordDetails({
        keywordId: Number(tag),
      });

      if (keywordDetails === null) {
        logger.warn('Skipping invalid keyword in blocklisted tags', {
          label: 'Blocklisted Tags Processor',
          keywordId: tag,
        });
        invalidKeywords.add(tag);
        continue;
      }

      await this.processTagForType(
        MediaType.MOVIE,
        tag,
        em,
        tmdb.getDiscoverMovies,
        MovieSortOptionsIterable,
        pageLimit
      );
      await this.processTagForType(
        MediaType.TV,
        tag,
        em,
        tmdb.getDiscoverTv,
        TvSortOptionsIterable,
        pageLimit
      );
    }

    if (invalidKeywords.size > 0) {
      const currentTags = blocklistedTagsArr.filter(
        (tag) => !invalidKeywords.has(tag)
      );
      const cleanedTags = currentTags.join(',');

      if (cleanedTags !== blocklistedTags) {
        settings.main.blocklistedTags = cleanedTags;
        await settings.save();

        logger.info('Cleaned up invalid keywords from settings', {
          label: 'Blocklisted Tags Processor',
          removedKeywords: Array.from(invalidKeywords),
          newBlocklistedTags: cleanedTags,
        });
      }
    }
  }

  private async processTagForType<S extends string>(
    type: VideoMediaType,
    tag: string,
    em: EntityManager,
    getDiscover: (options: {
      page: number;
      sortBy?: S;
      keywords: string;
    }) => Promise<TmdbSearchMovieResponse | TmdbSearchTvResponse>,
    sortOptions: readonly S[],
    pageLimit: number
  ): Promise<void> {
    let queryMax = pageLimit * sortOptions.length;
    let fixedSortMode = false;

    for (let query = 0; query < queryMax; query++) {
      const page: number = fixedSortMode
        ? query + 1
        : Math.floor(query / sortOptions.length) + 1;
      const sortBy: S | undefined = fixedSortMode
        ? undefined
        : sortOptions[query % sortOptions.length];

      if (!this.running) {
        throw new AbortTransaction();
      }

      try {
        const response = await getDiscover({ page, sortBy, keywords: tag });

        await this.processResults(response, tag, type, em);
        await new Promise((res) => setTimeout(res, TMDB_API_DELAY_MS));

        this.progress++;
        if (page === 1 && response.total_pages <= queryMax) {
          this.progress += queryMax - response.total_pages;
          fixedSortMode = true;
          queryMax = response.total_pages;
          // Reset so sequential paging resumes at page 2 even if earlier
          // queries failed.
          query = 0;
        }
      } catch (error) {
        this.incomplete = true;
        logger.error('Error processing keyword in blocklisted tags', {
          label: 'Blocklisted Tags Processor',
          keywordId: tag,
          errorMessage: error.message,
        });
      }
    }
  }

  private async processResults(
    response: TmdbSearchMovieResponse | TmdbSearchTvResponse,
    keywordId: string,
    mediaType: VideoMediaType,
    em: EntityManager
  ) {
    const blocklistRepository = em.getRepository(Blocklist);
    const mediaRepository = em.getRepository(Media);

    for (const entry of response.results) {
      const key = keyOf(mediaType, entry.id);
      const blocklistEntry = await blocklistRepository.findOne({
        where: { tmdbId: entry.id, mediaType },
      });

      if (!blocklistEntry) {
        const media = await mediaRepository.findOne({
          where: { tmdbId: entry.id, mediaType },
        });
        if (media && IN_LIBRARY.includes(media.status)) {
          continue;
        }
      }
      this.found.set(key, (this.found.get(key) ?? new Set()).add(keywordId));

      if (blocklistEntry) {
        // Skip manual blocklists; add this tag to the entry if it isn't there
        // yet.
        if (
          blocklistEntry.blocklistedTags &&
          !blocklistEntry.blocklistedTags.includes(`,${keywordId},`)
        ) {
          await blocklistRepository.update(blocklistEntry.id, {
            blocklistedTags: `${blocklistEntry.blocklistedTags}${keywordId},`,
          });
        }
      } else {
        // Not blocklisted yet: add it.
        await Blocklist.addToBlocklist(
          {
            blocklistRequest: {
              mediaType,
              title: 'title' in entry ? entry.title : entry.name,
              tmdbId: entry.id,
              blocklistedTags: `,${keywordId},`,
            },
          },
          em
        );
      }
    }
  }

  /**
   * Removes titles blocklisted by tags that no tag matches any more (with
   * their blocklist entries), and drops tags no longer matching from the rest.
   * Skipped when a lookup failed: what wasn't seen may still match.
   */
  private async cleanBlocklist(em: EntityManager) {
    if (this.incomplete) {
      logger.warn(
        'Some blocklisted tag lookups failed; titles no longer matching are removed next run',
        { label: 'Blocklisted Tags Processor' }
      );
      return;
    }
    const blocklistRepository = em.getRepository(Blocklist);
    const mediaRepository = em.getRepository(Media);
    const tagged = await blocklistRepository
      .createQueryBuilder('blist')
      .where('blist.blocklistedTags IS NOT NULL')
      .andWhere('blist.mediaType IN (:...videoTypes)', {
        videoTypes: VIDEO_MEDIA_TYPES,
      })
      .getMany();

    const stale: Blocklist[] = [];
    for (const entry of tagged) {
      const tags = this.found.get(keyOf(entry.mediaType, entry.tmdbId));
      if (!tags) {
        stale.push(entry);
        continue;
      }
      const current = `,${[...tags].sort().join(',')},`;
      if (entry.blocklistedTags !== current) {
        await blocklistRepository.update(entry.id, {
          blocklistedTags: current,
        });
      }
    }
    if (!stale.length) {
      return;
    }

    logger.info('Removing titles no blocklisted tag matches any more', {
      label: 'Blocklisted Tags Processor',
      count: stale.length,
    });
    // Batched to keep queries small. Removing a title cascades to its
    // blocklist entry; an entry left without a title is removed after.
    for (let i = 0; i < stale.length; i += 200) {
      const batch = stale.slice(i, i + 200);
      const media = await mediaRepository.find({
        where: batch.map((entry) => ({
          tmdbId: entry.tmdbId,
          mediaType: entry.mediaType,
        })),
      });
      await mediaRepository.remove(media);
      await blocklistRepository.delete({
        id: In(batch.map((entry) => entry.id)),
      });
    }
  }
}

const blocklistedTagsProcessor = new BlocklistedTagProcessor();

export default blocklistedTagsProcessor;
