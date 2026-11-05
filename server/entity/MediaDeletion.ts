import type { MediaType } from '@server/constants/media';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * When a title was last removed from the library.
 *
 * Separate from Media because a deletion can remove that row, and the date must
 * outlive it: watchlist sync uses it to tell a deliberate re-add from a title
 * still on a watchlist from before the deletion.
 */
@Entity()
@Unique(['tmdbId', 'mediaType'])
export class MediaDeletion {
  @PrimaryGeneratedColumn()
  public id: number;

  @Index()
  @Column()
  public tmdbId: number;

  @Column({ type: 'varchar' })
  public mediaType: MediaType;

  @DbAwareColumn({ type: 'datetime' })
  public deletedAt: Date;

  @CreateDateColumn({ type: resolveDbType('datetime') })
  public createdAt: Date;

  constructor(init?: Partial<MediaDeletion>) {
    Object.assign(this, init);
  }
}

export default MediaDeletion;
