import type { MediaStatus } from '@server/constants/media';
import { MediaRequestStatus } from '@server/constants/media';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { MediaRequest } from './MediaRequest';

/**
 * One album asked for in a music request, as a SeasonRequest is one season
 * of a series request. Its title is kept from when it was asked for.
 */
@Entity()
class AlbumRequest {
  @PrimaryGeneratedColumn()
  public id: number;

  /** The album's MusicBrainz release-group id. */
  @Column({ type: 'varchar' })
  @Index()
  public albumMbid: string;

  @Column({ type: 'varchar' })
  public title: string;

  @Column({ type: 'int', default: MediaRequestStatus.PENDING })
  public status: MediaRequestStatus;

  /**
   * Whether the album itself is here yet (its MusicAlbum's status). Not a
   * column: filled in where requests are listed (lib/music/albumStatuses).
   */
  public albumStatus?: MediaStatus;

  @ManyToOne(() => MediaRequest, (request) => request.albums, {
    onDelete: 'CASCADE',
  })
  @Index()
  public request: MediaRequest;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<AlbumRequest>) {
    Object.assign(this, init);
  }
}

export default AlbumRequest;
