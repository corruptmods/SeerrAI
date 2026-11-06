import type { MediaServerKind } from '@server/constants/server';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import Media from './Media';

/**
 * A title's item in one library of one media server, as the scans find it. A
 * title can sit in several libraries, each with its own item; the 4K copy is
 * recorded apart. Kept for showing people only what their libraries hold
 * (lib/libraryVisibility).
 */
@Entity()
@Index(['mediaId', 'server', 'libraryId', 'is4k'], { unique: true })
@Index(['server', 'libraryId'])
class MediaLibraryItem {
  /**
   * A library id as stored here. Jellyfin and Emby ids are compared without
   * dashes or case, as their endpoints differ in both.
   */
  public static key(server: MediaServerKind, libraryId: string): string {
    return server === 'plex'
      ? libraryId
      : libraryId.replace(/-/g, '').toLowerCase();
  }

  @PrimaryGeneratedColumn()
  public id: number;

  @ManyToOne(() => Media, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'mediaId' })
  @Index()
  public media: Media;

  @Column()
  public mediaId: number;

  @Column({ type: 'varchar' })
  public server: MediaServerKind;

  /** The library's id as the scans use it (normalized, see libraryKey). */
  @Column({ type: 'varchar' })
  public libraryId: string;

  @Column({ type: 'boolean', default: false })
  public is4k: boolean;

  /** The title's item id in that library. */
  @Column({ type: 'varchar' })
  public itemId: string;

  constructor(init?: Partial<MediaLibraryItem>) {
    Object.assign(this, init);
  }
}

export default MediaLibraryItem;
