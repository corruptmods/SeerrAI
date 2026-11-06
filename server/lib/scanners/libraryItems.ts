import type { MediaServerKind } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import MediaLibraryItem from '@server/entity/MediaLibraryItem';
import logger from '@server/logger';
import { In } from 'typeorm';

/** Rows removed per delete. */
const DELETE_CHUNK = 500;

const keyOf = (mediaId: number, is4k: boolean): string =>
  `${mediaId}:${is4k ? '4k' : 'std'}`;

/**
 * Records which library of a media server each title a scan finds is in, one
 * library at a time. Writes only what changed; after a full pass of a library,
 * prune() forgets titles it no longer holds.
 */
export class LibraryItems {
  private libraryId?: string;
  private known = new Map<string, Pick<MediaLibraryItem, 'id' | 'itemId'>>();
  private seen = new Set<string>();

  constructor(public readonly server: MediaServerKind) {}

  /** Starts on a library: reads what is recorded for it. */
  public async begin(libraryId: string): Promise<void> {
    this.libraryId = undefined;
    this.seen.clear();
    const key = MediaLibraryItem.key(this.server, libraryId);
    const rows = await getRepository(MediaLibraryItem).find({
      select: { id: true, mediaId: true, is4k: true, itemId: true },
      where: { server: this.server, libraryId: key },
    });
    this.known = new Map(
      rows.map((row) => [keyOf(row.mediaId, row.is4k), row])
    );
    this.libraryId = key;
  }

  /** The current library holds this item of a title. */
  public async place(
    mediaId: number,
    is4k: boolean,
    itemId: string
  ): Promise<void> {
    const libraryId = this.libraryId;
    if (!libraryId) return;
    const key = keyOf(mediaId, is4k);
    this.seen.add(key);
    if (this.known.get(key)?.itemId === itemId) return;
    try {
      await getRepository(MediaLibraryItem).upsert(
        { mediaId, server: this.server, libraryId, is4k, itemId },
        ['mediaId', 'server', 'libraryId', 'is4k']
      );
      this.known.set(key, { id: this.known.get(key)?.id ?? 0, itemId });
    } catch (e) {
      // Not knowing the library only shows the title as before.
      logger.warn('Could not record which library holds a title', {
        label: 'Library Items',
        server: this.server,
        mediaId,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Ends the library after a full, clean pass: what it held before but not
   * now is forgotten.
   */
  public async prune(): Promise<number> {
    const gone = [...this.known.entries()]
      .filter(([key, row]) => row.id && !this.seen.has(key))
      .map(([, row]) => row.id);
    this.end();
    for (let i = 0; i < gone.length; i += DELETE_CHUNK) {
      await getRepository(MediaLibraryItem).delete({
        id: In(gone.slice(i, i + DELETE_CHUNK)),
      });
    }
    return gone.length;
  }

  /** Ends the library without forgetting anything. */
  public end(): void {
    this.libraryId = undefined;
    this.known.clear();
    this.seen.clear();
  }

  /** Whether a library is being recorded. */
  public get active(): boolean {
    return !!this.libraryId;
  }
}
