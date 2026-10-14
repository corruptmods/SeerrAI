import { MediaStatus } from '@server/constants/media';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import Media from './Media';

/**
 * One album of an artist (a Media row of type music), as a season is one
 * part of a series. Its title, kind and date are kept here so request cards
 * and notifications need no MusicBrainz lookup.
 *
 * Not loaded with the artist: music code loads albums when it needs them,
 * so queries about films and series never join them.
 */
@Entity()
@Index(['mediaId', 'mbId'], { unique: true })
class MusicAlbum {
  @PrimaryGeneratedColumn()
  public id: number;

  @ManyToOne(() => Media, (media) => media.musicAlbums, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'mediaId' })
  @Index()
  public media: Media;

  @Column()
  public mediaId: number;

  /**
   * The album's MusicBrainz release-group id. Null for an album found on a
   * media server that could not be matched to one.
   */
  @Column({ type: 'varchar', nullable: true })
  public mbId?: string | null;

  @Column({ type: 'varchar' })
  public title: string;

  /** MusicBrainz's primary type: Album, EP, Single, Broadcast or Other. */
  @Column({ type: 'varchar', nullable: true })
  public primaryType?: string | null;

  /** MusicBrainz's secondary types, such as Live or Compilation. */
  @Column({ type: 'simple-array', default: '' })
  public secondaryTypes: string[];

  /** As precise as MusicBrainz knows it: "2004", "2004-03" or a full date. */
  @Column({ type: 'varchar', nullable: true })
  public releaseDate?: string | null;

  @Column({ type: 'int', default: MediaStatus.UNKNOWN })
  @Index()
  public status: MediaStatus;

  /** The album's id in Lidarr, once Lidarr has it. */
  @Column({ type: 'int', nullable: true })
  public lidarrAlbumId?: number | null;

  /** Tracks on the release Lidarr chose, and how many it has files for. */
  @Column({ type: 'int', nullable: true })
  public trackCount?: number | null;

  @Column({ type: 'int', nullable: true })
  public trackFileCount?: number | null;

  /** The album's id on each media server (see MUSIC_ALBUM_ID). */
  @Column({ type: 'varchar', nullable: true })
  public ratingKey?: string | null;

  @Column({ type: 'varchar', nullable: true })
  public jellyfinItemId?: string | null;

  @Column({ type: 'varchar', nullable: true })
  public embyItemId?: string | null;

  /** The album's folder name, last seen, for matching by folder. */
  @Column({ type: 'varchar', nullable: true })
  public folder?: string | null;

  /** When a media server first had it. */
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public mediaAddedAt?: Date | null;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<MusicAlbum>) {
    Object.assign(this, init);
  }
}

export default MusicAlbum;
