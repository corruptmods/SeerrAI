import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './User';

/** A user-created list of media, visible only to its owner and members. */
@Entity()
export class MediaList {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column()
  public name: string;

  @ManyToOne(() => User, { eager: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ownerId' })
  @Index()
  public owner: User;

  @Column()
  public ownerId: number;

  /**
   * When on, a scheduled job checks Tautulli and suggests removing titles
   * everyone on the list has finished. Off by default: watching people's
   * viewing history is opt-in per list.
   */
  @Column({ default: false })
  public watchedSync: boolean;

  /** Throttles the Tautulli check so it does not run on every page load. */
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastWatchCheck?: Date | null;

  @OneToMany(() => MediaListItem, (item: MediaListItem) => item.list)
  public items: MediaListItem[];

  @OneToMany(() => MediaListMember, (member: MediaListMember) => member.list)
  public members: MediaListMember[];

  @CreateDateColumn()
  public createdAt: Date;

  @UpdateDateColumn()
  public updatedAt: Date;

  constructor(init?: Partial<MediaList>) {
    Object.assign(this, init);
  }
}

/** One title on a list. */
@Entity()
@Unique(['list', 'tmdbId', 'mediaType'])
export class MediaListItem {
  @PrimaryGeneratedColumn()
  public id: number;

  @ManyToOne(() => MediaList, (list: MediaList) => list.items, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'listId' })
  @Index()
  public list: MediaList;

  @Column()
  public listId: number;

  @Column()
  public tmdbId: number;

  @Column({ type: 'varchar' })
  public mediaType: 'movie' | 'tv';

  /**
   * Cached TMDB poster path. Kept here so the lists overview can draw its
   * artwork without a TMDB lookup per title — which is what limited the
   * rotation to a handful of posters.
   */
  @Column({ type: 'varchar', nullable: true })
  public posterPath?: string | null;

  /** Who added it. Kept so a shared list shows attribution. */
  @ManyToOne(() => User, { eager: true, onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'addedById' })
  public addedBy?: User | null;

  @Column({ nullable: true })
  public addedById?: number | null;

  /** Set when someone marks the title watched; null while outstanding. */
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public watchedAt?: Date | null;

  @ManyToOne(() => User, { eager: true, onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'watchedById' })
  public watchedBy?: User | null;

  @Column({ nullable: true })
  public watchedById?: number | null;

  @CreateDateColumn()
  public createdAt: Date;

  constructor(init?: Partial<MediaListItem>) {
    Object.assign(this, init);
  }
}

/** A user the list has been shared with. */
@Entity()
@Unique(['list', 'user'])
export class MediaListMember {
  @PrimaryGeneratedColumn()
  public id: number;

  @ManyToOne(() => MediaList, (list: MediaList) => list.members, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'listId' })
  @Index()
  public list: MediaList;

  @Column()
  public listId: number;

  @ManyToOne(() => User, { eager: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  @Index()
  public user: User;

  @Column()
  public userId: number;

  constructor(init?: Partial<MediaListMember>) {
    Object.assign(this, init);
  }
}

/**
 * A title the job believes everyone on the list has finished. Surfaced to the
 * list owner as a prompt; nothing is ever removed automatically.
 */
@Entity()
@Unique(['item'])
export class MediaListWatchSuggestion {
  @PrimaryGeneratedColumn()
  public id: number;

  @ManyToOne(() => MediaList, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'listId' })
  @Index()
  public list: MediaList;

  @Column()
  public listId: number;

  @ManyToOne(() => MediaListItem, { eager: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'itemId' })
  public item: MediaListItem;

  @Column()
  public itemId: number;

  /** Set when the owner chose to keep it, so it is not suggested again. */
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public dismissedAt?: Date | null;

  @CreateDateColumn()
  public createdAt: Date;

  constructor(init?: Partial<MediaListWatchSuggestion>) {
    Object.assign(this, init);
  }
}

export default MediaList;
