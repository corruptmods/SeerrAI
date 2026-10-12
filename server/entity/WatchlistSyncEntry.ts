import type { MediaType } from '@server/constants/media';
import { User } from '@server/entity/User';
import { WatchlistSyncEntrySeason } from '@server/entity/WatchlistSyncEntrySeason';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

export type WatchlistSource = 'plex' | 'trakt';

@Entity()
@Unique('UNIQUE_WATCHLIST_SYNC_ENTRY', ['requestedBy', 'tmdbId', 'mediaType'])
export class WatchlistSyncEntry {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column()
  @Index()
  public tmdbId: number;

  @Column({ type: 'varchar' })
  public mediaType: MediaType;

  // Unix seconds, verbatim from Plex or Trakt (see watchlistedFrom).
  @Column({ type: 'int' })
  public watchlistedAt: number;

  /**
   * Which watchlist watchlistedAt came from; null for entries made before
   * Trakt, which are Plex's. A different time from the same watchlist is a
   * re-add; from the other one it is the same entry.
   */
  @Column({ type: 'varchar', nullable: true })
  public watchlistedFrom?: WatchlistSource | null;

  @ManyToOne(() => User, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  @Index()
  public requestedBy: User;

  @OneToMany(() => WatchlistSyncEntrySeason, (season) => season.entry, {
    cascade: true,
    eager: true,
  })
  public seasons: WatchlistSyncEntrySeason[];

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<WatchlistSyncEntry>) {
    Object.assign(this, init);
  }
}
