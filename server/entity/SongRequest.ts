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
 * One song asked for in a music request, beside the albums it may hold:
 * one version of it (a MusicBrainz recording), as it was when asked for,
 * so cards and notifications never wait on MusicBrainz.
 */
@Entity()
class SongRequest {
  @PrimaryGeneratedColumn()
  public id: number;

  /** The version asked for: its MusicBrainz recording id. */
  @Column({ type: 'varchar' })
  @Index()
  public recordingMbid: string;

  /** The song's title, without what names the version. */
  @Column({ type: 'varchar' })
  public title: string;

  /** What tells the version apart ("radio edit"), when anything does. */
  @Column({ type: 'varchar', nullable: true })
  public version: string | null;

  /** Milliseconds. */
  @Column({ type: 'int', nullable: true })
  public length: number | null;

  /** The album or single it is best known from (a release-group id). */
  @Column({ type: 'varchar', nullable: true })
  public albumMbid: string | null;

  @Column({ type: 'varchar', nullable: true })
  public albumTitle: string | null;

  /**
   * The single or EP it is fetched through: one of the artist's that holds
   * this very version, as Lidarr adds any album. None when it is only on
   * albums.
   */
  @Column({ type: 'varchar', nullable: true })
  public singleMbid: string | null;

  @Column({ type: 'varchar', nullable: true })
  public singleTitle: string | null;

  /**
   * The album it is taken from when it is on no single: the artist's own,
   * the earliest (see lib/music/songs albumFor). Only once Settings → Music
   * allows songs to be taken from albums.
   */
  @Column({ type: 'varchar', nullable: true })
  public sourceAlbumMbid: string | null;

  @Column({ type: 'varchar', nullable: true })
  public sourceAlbumTitle: string | null;

  /** Every album and single it is on, best known first. */
  @Column({ type: 'simple-array', default: '' })
  public releaseGroups: string[];

  @Column({ type: 'int', default: MediaRequestStatus.PENDING })
  public status: MediaRequestStatus;

  /**
   * For one being taken from an album: what is being done for it now
   * ("Downloading, 40%"). Not a column: filled in where requests are
   * listed (lib/music/albumStatuses).
   */
  public fetchStage?: string;

  @ManyToOne(() => MediaRequest, (request) => request.songs, {
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

  constructor(init?: Partial<SongRequest>) {
    Object.assign(this, init);
  }
}

export default SongRequest;
