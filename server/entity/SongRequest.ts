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
 * One song in a music request, alongside its albums: one version (a MusicBrainz
 * recording), stored as requested so cards and notifications never wait on
 * MusicBrainz.
 */
@Entity()
class SongRequest {
  @PrimaryGeneratedColumn()
  public id: number;

  /** The requested version's MusicBrainz recording id. */
  @Column({ type: 'varchar' })
  @Index()
  public recordingMbid: string;

  /** The song's title, without the version qualifier. */
  @Column({ type: 'varchar' })
  public title: string;

  /** The version qualifier ("radio edit"), if any. */
  @Column({ type: 'varchar', nullable: true })
  public version: string | null;

  /** Milliseconds. */
  @Column({ type: 'int', nullable: true })
  public length: number | null;

  /** The album or single it's best known from (a release-group id). */
  @Column({ type: 'varchar', nullable: true })
  public albumMbid: string | null;

  @Column({ type: 'varchar', nullable: true })
  public albumTitle: string | null;

  /**
   * The single or EP it's fetched through: one of the artist's containing this
   * exact version, added like any album in Lidarr. Null when it's only on
   * albums.
   */
  @Column({ type: 'varchar', nullable: true })
  public singleMbid: string | null;

  @Column({ type: 'varchar', nullable: true })
  public singleTitle: string | null;

  /**
   * The album it's taken from when on no single: the artist's own, earliest
   * (see lib/music/songs albumFor). Only once Settings → Music allows taking
   * songs from albums.
   */
  @Column({ type: 'varchar', nullable: true })
  public sourceAlbumMbid: string | null;

  @Column({ type: 'varchar', nullable: true })
  public sourceAlbumTitle: string | null;

  /** Every album and single it's on, best known first. */
  @Column({ type: 'simple-array', default: '' })
  public releaseGroups: string[];

  @Column({ type: 'int', default: MediaRequestStatus.PENDING })
  public status: MediaRequestStatus;

  /**
   * For a song taken from an album: its current progress ("Downloading, 40%").
   * Not a column: filled where requests are listed (lib/music/albumStatuses).
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
