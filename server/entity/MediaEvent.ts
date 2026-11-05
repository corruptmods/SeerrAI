import type { MediaType } from '@server/constants/media';
import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum MediaEventType {
  REQUESTED = 'requested',
  APPROVED = 'approved',
  DECLINED = 'declined',
  FAILED = 'failed',
  PROCESSING = 'processing',
  PARTIALLY_AVAILABLE = 'partially_available',
  AVAILABLE = 'available',
  /** Seerr marked it gone from the library. */
  REMOVED = 'removed',
  /** Files deleted via Radarr or Sonarr, from Seerr. */
  FILES_REMOVED = 'files_removed',
  BLOCKLISTED = 'blocklisted',
  UNBLOCKLISTED = 'unblocklisted',
  /** Kept from a Maintainerr deletion. */
  KEPT = 'kept',
  /** Radarr or Sonarr told to search for what's missing. */
  SEARCHED = 'searched',
  /**
   * Sonarr's episode monitoring couldn't be reconciled with the requests: it
   * may download more than asked, or keep monitoring unwanted episodes.
   */
  MONITORING_FAILED = 'monitoring_failed',
  /**
   * The admin agent searched for what was missing; the detail has the outcome.
   */
  AGENT = 'agent',
  /**
   * Not recorded. The first history backfill wrote these with dates that aren't
   * when titles reached the library; a migration removes them.
   */
  ADDED = 'added',
}

/**
 * One event in a title's history, for the manage panel.
 *
 * Keyed by title, not Media row (like MediaDeletion): rows get deleted and
 * history must outlive them. The user is stored as an id without a foreign key
 * for the same reason.
 */
@Entity()
@Index(['mediaType', 'tmdbId'])
export class MediaEvent {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column()
  public tmdbId: number;

  /** For music (tmdbId 0): the artist's MusicBrainz id. */
  @Column({ type: 'varchar', nullable: true })
  @Index()
  public foreignId?: string | null;

  @Column({ type: 'varchar' })
  public mediaType: MediaType;

  @Column({ type: 'varchar' })
  public type: MediaEventType;

  @Column({ default: false })
  public is4k: boolean;

  @Column({ type: 'integer', nullable: true })
  public userId?: number | null;

  /** A reason, or other details. */
  @Column({ type: 'varchar', nullable: true })
  public detail?: string | null;

  /** Settable, so backfilled events keep their real dates. */
  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public occurredAt: Date;

  constructor(init?: Partial<MediaEvent>) {
    Object.assign(this, init);
  }
}

export default MediaEvent;
