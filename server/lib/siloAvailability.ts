import type SiloAPI from '@server/api/silo/client';
import type { SiloCatalogItem } from '@server/api/silo/types';
import { getRepository } from '@server/datasource';
import type Media from '@server/entity/Media';
import SiloEpisode from '@server/entity/SiloEpisode';
import { forgetEpisodes } from '@server/lib/scanners/silo/episodes';
import { isSilo4k } from '@server/lib/silo';

/*
 * What Silo still has, for the availability sync. Silo has no "item gone"
 * answer: an id missing from a content_ids listing is gone.
 */

/** What Silo said about one version of a title. */
export interface SiloCheck {
  exists: boolean;
  /** Silo answered without the item: its id is stale. */
  gone: boolean;
  /** For a series: the seasons with an episode on this side. */
  seasons?: Set<number>;
}

export class SiloAvailability {
  /** Items by content id, null when Silo no longer has one; per sync. */
  private items = new Map<string, Promise<SiloCatalogItem | null>>();
  /** Series' remaining episodes, per sync. */
  private episodes = new Map<string, Promise<SiloEpisode[]>>();

  constructor(
    private readonly client: SiloAPI,
    private readonly enable4kMovie: boolean,
    private readonly enable4kShow: boolean
  ) {}

  private item(contentId: string): Promise<SiloCatalogItem | null> {
    let found = this.items.get(contentId);
    if (!found) {
      found = this.client
        .getCatalogItems([contentId])
        .then(
          (items) => items.find((item) => item.content_id === contentId) ?? null
        );
      this.items.set(contentId, found);
      // A failed read is asked again next time.
      found.catch(() => this.items.delete(contentId));
    }
    return found;
  }

  /**
   * The stored episodes of a series Silo still has; the rest are forgotten.
   */
  private remainingEpisodes(seriesId: string): Promise<SiloEpisode[]> {
    let remaining = this.episodes.get(seriesId);
    if (!remaining) {
      remaining = (async () => {
        const rows = await getRepository(SiloEpisode).find({
          where: { seriesId },
        });
        if (!rows.length) return rows;
        const present = new Set(
          (await this.client.getCatalogItems(rows.map((row) => row.contentId)))
            .filter((item) => item.series_id === seriesId)
            .map((item) => item.content_id)
        );
        const gone = rows.filter((row) => !present.has(row.contentId));
        if (gone.length) {
          await forgetEpisodes(gone.map((row) => row.contentId));
        }
        return rows.filter((row) => present.has(row.contentId));
      })();
      this.episodes.set(seriesId, remaining);
      remaining.catch(() => this.episodes.delete(seriesId));
    }
    return remaining;
  }

  /**
   * One version of a title. Throws when Silo couldn't answer; the caller
   * then keeps the title as it is.
   */
  public async check(media: Media, is4k: boolean): Promise<SiloCheck> {
    const id = is4k ? media.siloMediaId4k : media.siloMediaId;
    if (!id) {
      return media.mediaType === 'tv'
        ? { exists: false, gone: false, seasons: new Set() }
        : { exists: false, gone: false };
    }
    const item = await this.item(id);
    if (!item) {
      return media.mediaType === 'tv'
        ? { exists: false, gone: true, seasons: new Set() }
        : { exists: false, gone: true };
    }

    if (media.mediaType !== 'tv') {
      const versions = item.versions ?? [];
      const exists = is4k
        ? versions.some(isSilo4k)
        : versions.some((version) => !isSilo4k(version)) ||
          (!this.enable4kMovie && versions.length > 0);
      return { exists, gone: false };
    }

    const seasons = new Set<number>();
    for (const row of await this.remainingEpisodes(id)) {
      const onSide = is4k
        ? row.uhd
        : row.standard || (!this.enable4kShow && row.uhd);
      if (onSide) seasons.add(row.season);
    }
    return { exists: true, gone: false, seasons };
  }
}
