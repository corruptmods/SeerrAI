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
  /** Files deleted through Radarr or Sonarr, from Seerr. */
  FILES_REMOVED = 'files_removed',
  BLOCKLISTED = 'blocklisted',
  UNBLOCKLISTED = 'unblocklisted',
  /** Kept from a Maintainerr deletion. */
  KEPT = 'kept',
  /** Radarr or Sonarr asked to search for what it was missing. */
  SEARCHED = 'searched',
  /**
   * Sonarr's episode monitoring could not be brought in line with the
   * requests: it may download more than was asked for, or keep watching
   * episodes nobody wants any more.
   */
  MONITORING_FAILED = 'monitoring_failed',
  /** The admin agent looked for what it was missing; the detail says how it went. */
  AGENT = 'agent',
  /**
   * No longer recorded. The first history backfill wrote these from a date
   * that is not really when a title reached the library; a later migration
   * removes them.
   */
  ADDED = 'added',
}

/**
 * One thing that happened to a title, for its history in the manage panel.
 *
 * Keyed by title rather than by Media row, as MediaDeletion is: rows get
 * deleted, and a title's history has to outlive them. The user is stored as
 * an id without a foreign key for the same reason.
 */
@Entity()
@Index(['mediaType', 'tmdbId'])
export class MediaEvent {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column()
  public tmdbId: number;

  @Column({ type: 'varchar' })
  public mediaType: MediaType;

  @Column({ type: 'varchar' })
  public type: MediaEventType;

  @Column({ default: false })
  public is4k: boolean;

  @Column({ type: 'integer', nullable: true })
  public userId?: number | null;

  /** A reason, or what else happened with it. */
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
