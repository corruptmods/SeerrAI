import type { PlexLibraryItem } from '@server/api/plexapi';

/*
 * Titles the recently added scan could not place yet. Plex adds a file
 * before its agent has matched it (no TMDB or TVDB id yet), and a lookup
 * can fail for a moment; the scan window moves on regardless, so without
 * a second look such a title waited for the nightly full scan. Each is
 * tried again, less often each time, for a day.
 */

/** How long a title is tried again before the full scan is left to it. */
export const RETRY_FOR_MS = 24 * 60 * 60 * 1000;
const FIRST_RETRY_MS = 5 * 60 * 1000;
const LONGEST_RETRY_MS = 2 * 60 * 60 * 1000;

export interface RetryEntry {
  item: PlexLibraryItem;
  firstFailedAt: number;
  attempts: number;
  nextAt: number;
  error: string;
}

/** The title an item belongs to: a show for its episodes, else itself. */
export const titleKey = (item: PlexLibraryItem) =>
  item.grandparentRatingKey ?? item.parentRatingKey ?? item.ratingKey;

export class RecentRetries {
  private byLibrary = new Map<string, Map<string, RetryEntry>>();

  private of(libraryId: string) {
    let entries = this.byLibrary.get(libraryId);
    if (!entries) {
      entries = new Map();
      this.byLibrary.set(libraryId, entries);
    }
    return entries;
  }

  /** The titles due another look now. */
  public due(libraryId: string, now = Date.now()): RetryEntry[] {
    return [...this.of(libraryId).values()].filter((e) => e.nextAt <= now);
  }

  /**
   * A title that could not be placed. Answers true once it has been tried
   * for a day: it is dropped, and the full scan is left to it.
   */
  public failed(
    libraryId: string,
    item: PlexLibraryItem,
    error: string,
    now = Date.now()
  ): boolean {
    const entries = this.of(libraryId);
    const key = titleKey(item);
    const known = entries.get(key);
    if (!known) {
      entries.set(key, {
        item,
        firstFailedAt: now,
        attempts: 1,
        nextAt: now + FIRST_RETRY_MS,
        error,
      });
      return false;
    }
    if (now - known.firstFailedAt >= RETRY_FOR_MS) {
      entries.delete(key);
      return true;
    }
    known.attempts += 1;
    known.item = item;
    known.error = error;
    known.nextAt =
      now +
      Math.min(FIRST_RETRY_MS * 2 ** (known.attempts - 1), LONGEST_RETRY_MS);
    return false;
  }

  public succeeded(libraryId: string, item: PlexLibraryItem): void {
    this.of(libraryId).delete(titleKey(item));
  }

  /** A title Plex no longer has. */
  public forget(libraryId: string, item: PlexLibraryItem): void {
    this.of(libraryId).delete(titleKey(item));
  }

  public count(libraryId: string): number {
    return this.of(libraryId).size;
  }

  public clear(): void {
    this.byLibrary.clear();
  }
}
