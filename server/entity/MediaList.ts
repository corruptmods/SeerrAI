import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
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

/** What a list holds: films and series, or songs. */
export type MediaListKind = 'watch' | 'music';

/** Where a playlist's songs come from, besides being added by hand. */
export type PlaylistService = 'spotify' | 'apple';

/** A user-created list of media, visible only to its owner and members. */
@Entity()
export class MediaList {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column()
  public name: string;

  /** A watch list (films and series) or a playlist (songs). */
  @Column({ type: 'varchar', default: 'watch' })
  public kind: MediaListKind;

  /**
   * A playlist's linked Spotify or Apple Music playlist: its public link,
   * read again daily for songs added since.
   */
  @Column({ type: 'varchar', nullable: true })
  public sourceUrl?: string | null;

  @Column({ type: 'varchar', nullable: true })
  public sourceService?: PlaylistService | null;

  /** Its name there, as last read. */
  @Column({ type: 'varchar', nullable: true })
  public sourceName?: string | null;

  /** Whom the songs read from it are requested for: who linked it. */
  @Column({ type: 'integer', nullable: true })
  public sourceUserId?: number | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public sourceReadAt?: Date | null;

  /** Why it could not be read the last time, if it could not. */
  @Column({ type: 'varchar', nullable: true })
  public sourceProblem?: string | null;

  @ManyToOne(() => User, { eager: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ownerId' })
  @Index()
  public owner: User;

  @Column()
  public ownerId: number;

  /**
   * When on, a scheduled job checks the watch history and suggests removing titles
   * everyone on the list has finished. Off by default: watching people's
   * viewing history is opt-in per list.
   */
  @Column({ default: false })
  public watchedSync: boolean;

  /** Throttles the watch-history check so it does not run on every page load. */
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastWatchCheck?: Date | null;

  @OneToMany(() => MediaListItem, (item: MediaListItem) => item.list)
  public items: MediaListItem[];

  @OneToMany(() => MediaListMember, (member: MediaListMember) => member.list)
  public members: MediaListMember[];

  @OneToMany(() => MediaListSong, (song: MediaListSong) => song.list)
  public songs: MediaListSong[];

  @CreateDateColumn({ type: resolveDbType('datetime') })
  public createdAt: Date;

  @UpdateDateColumn({ type: resolveDbType('datetime') })
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

  @CreateDateColumn({ type: resolveDbType('datetime') })
  public createdAt: Date;

  constructor(init?: Partial<MediaListItem>) {
    Object.assign(this, init);
  }
}

/**
 * Where a song on a playlist is: being matched on MusicBrainz, not found
 * there, matched and about to be requested, requested (or here or on its
 * way already), waiting (for its requester's limit, `problem` "limit"),
 * waiting for an admin to approve a big import, or not requestable; or
 * taken off a linked playlist, kept so it isn't read back in.
 */
export type PlaylistSongState =
  | 'matching'
  | 'unmatched'
  | 'matched'
  | 'requested'
  | 'here'
  | 'waiting'
  | 'approval'
  | 'failed'
  | 'removed';

/** One song on a playlist, as its service or its adder named it. */
@Entity()
@Unique(['list', 'sourceId'])
export class MediaListSong {
  @PrimaryGeneratedColumn()
  public id: number;

  @ManyToOne(() => MediaList, (list: MediaList) => list.songs, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'listId' })
  @Index()
  public list: MediaList;

  @Column()
  public listId: number;

  /** The service's own id for it ("spotify:track:…"), or the recording's. */
  @Column({ type: 'varchar' })
  public sourceId: string;

  /** Its place in the playlist. */
  @Column({ type: 'integer', default: 0 })
  public position: number;

  @Column({ type: 'varchar' })
  public title: string;

  @Column({ type: 'varchar' })
  public artistName: string;

  /** Milliseconds, when the service says. */
  @Column({ type: 'integer', nullable: true })
  public length?: number | null;

  /** What it was matched to on MusicBrainz. */
  @Column({ type: 'varchar', nullable: true })
  @Index()
  public recordingMbid?: string | null;

  @Column({ type: 'varchar', nullable: true })
  public artistMbid?: string | null;

  /** The album it is best known from, for its cover. */
  @Column({ type: 'varchar', nullable: true })
  public albumMbid?: string | null;

  @Column({ type: 'varchar', default: 'matching' })
  public state: PlaylistSongState;

  /** Why it is not requested, when it could not be. */
  @Column({ type: 'varchar', nullable: true })
  public problem?: string | null;

  /** The music request it went in. */
  @Column({ type: 'integer', nullable: true })
  public requestId?: number | null;

  /** Who it is requested for: who added it, or linked the playlist. */
  @Column({ type: 'integer', nullable: true })
  public requestForId?: number | null;

  @CreateDateColumn({ type: resolveDbType('datetime') })
  public createdAt: Date;

  @UpdateDateColumn({ type: resolveDbType('datetime') })
  public updatedAt: Date;

  constructor(init?: Partial<MediaListSong>) {
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

  /**
   * When the member accepted the list. Until then they can see it, but
   * nothing that reads their watch history (watch sync, picks for a room)
   * counts them: being added to a list is not agreeing to share what you
   * watch.
   */
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public acceptedAt?: Date | null;

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

  @CreateDateColumn({ type: resolveDbType('datetime') })
  public createdAt: Date;

  constructor(init?: Partial<MediaListWatchSuggestion>) {
    Object.assign(this, init);
  }
}

export default MediaList;
