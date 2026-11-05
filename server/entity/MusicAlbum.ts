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
 * One album of an artist (a music Media row), like a season of a series. Title,
 * kind and date are stored so request cards and notifications need no
 * MusicBrainz lookup.
 *
 * Not loaded with the artist: music code loads albums when needed, so film and
 * series queries never join them.
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
   * The MusicBrainz release-group id. Null for a media server album that
   * couldn't be matched.
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

  /** As precise as MusicBrainz knows: "2004", "2004-03" or a full date. */
  @Column({ type: 'varchar', nullable: true })
  public releaseDate?: string | null;

  @Column({ type: 'int', default: MediaStatus.UNKNOWN })
  @Index()
  public status: MediaStatus;

  /** The album's id in Lidarr, once Lidarr has it. */
  @Column({ type: 'int', nullable: true })
  public lidarrAlbumId?: number | null;

  /** Tracks on Lidarr's chosen release, and how many have files. */
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

  /** The album's last seen folder name, for matching by folder. */
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
