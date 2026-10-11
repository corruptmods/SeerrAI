import type { MediaType } from '@server/constants/media';
import { DbAwareColumn } from '@server/utils/DbColumnHelper';
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
 * Kept separately from Media because a deletion can remove that row outright,
 * and the date has to outlive it: watchlist sync uses it to tell a title
 * somebody re-added on purpose from one still sitting on a watchlist from
 * before it was deleted.
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

  @CreateDateColumn()
  public createdAt: Date;

  constructor(init?: Partial<MediaDeletion>) {
    Object.assign(this, init);
  }
}

export default MediaDeletion;
