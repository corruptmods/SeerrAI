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
 * One album in a music request, like a SeasonRequest in a series request. Its
 * title is stored as requested.
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
   * column: filled where requests are listed (lib/music/albumStatuses).
   */
  public albumStatus?: MediaStatus;

  /** Lidarr has its files but no media server lists it yet. Not a column. */
  public addingToLibrary?: boolean;

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
