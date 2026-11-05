import type { CatalogSong } from '@server/lib/music/catalogSong';
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

/** A list's contents: films and series, or songs. */
export type MediaListKind = 'watch' | 'music';

/** Where a playlist's songs come from, besides manual adds. */
export type PlaylistService = 'spotify' | 'apple';

/** A user-created list, visible only to its owner and members. */
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
   * The public link of a linked Spotify or Apple Music playlist, re-read daily
   * for new songs.
   */
  @Column({ type: 'varchar', nullable: true })
  public sourceUrl?: string | null;

  @Column({ type: 'varchar', nullable: true })
  public sourceService?: PlaylistService | null;

  /** The linked playlist's name, as last read. */
  @Column({ type: 'varchar', nullable: true })
  public sourceName?: string | null;

  /** Who linked the playlist; its songs are requested for them. */
  @Column({ type: 'integer', nullable: true })
  public sourceUserId?: number | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public sourceReadAt?: Date | null;

  /** Why the last read failed, if it did. */
  @Column({ type: 'varchar', nullable: true })
  public sourceProblem?: string | null;

  @ManyToOne(() => User, { eager: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ownerId' })
  @Index()
  public owner: User;

  @Column()
  public ownerId: number;

  /**
   * When on, a scheduled job checks watch history and suggests removing titles
   * everyone on the list has finished. Off by default: reading viewing history
   * is opt-in per list.
   */
  @Column({ default: false })
  public watchedSync: boolean;

  /** Throttles the watch-history check so it doesn't run on every page load. */
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
   * Cached TMDB poster path, so the lists overview draws artwork without a TMDB
   * lookup per title.
   */
  @Column({ type: 'varchar', nullable: true })
  public posterPath?: string | null;

  /** Who added it, for attribution on shared lists. */
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
 * A playlist song's state: being matched on MusicBrainz, not found, matched and
 * about to be requested, requested (or already here or coming), waiting (on the
 * requester's quota, `problem` "limit"), awaiting admin approval of a big
 * import, or not requestable; or removed from a linked playlist and kept so it
 * isn't re-imported.
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

/** One song on a playlist, as its service or adder named it. */
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

  /** The service's id ("spotify:track:…"), or the recording's. */
  @Column({ type: 'varchar' })
  public sourceId: string;

  /** Position in the playlist. */
  @Column({ type: 'integer', default: 0 })
  public position: number;

  @Column({ type: 'varchar' })
  public title: string;

  @Column({ type: 'varchar' })
  public artistName: string;

  /** Milliseconds, when the service provides it. */
  @Column({ type: 'integer', nullable: true })
  public length?: number | null;

  /** The matched MusicBrainz recording. */
  @Column({ type: 'varchar', nullable: true })
  @Index()
  public recordingMbid?: string | null;

  @Column({ type: 'varchar', nullable: true })
  public artistMbid?: string | null;

  /** The album it's best known from, for its cover. */
  @Column({ type: 'varchar', nullable: true })
  public albumMbid?: string | null;

  /** The recording's ISRC from Deezer, when listed. */
  @Column({ type: 'varchar', nullable: true })
  public isrc?: string | null;

  /**
   * The song's Deezer album and track, when listed, for adding songs
   * MusicBrainz lacks.
   */
  @Column({ type: 'simple-json', nullable: true })
  public catalog?: CatalogSong | null;

  @Column({ type: 'varchar', default: 'matching' })
  public state: PlaylistSongState;

  /** Why it couldn't be requested. */
  @Column({ type: 'varchar', nullable: true })
  public problem?: string | null;

  /** The music request it went into. */
  @Column({ type: 'integer', nullable: true })
  public requestId?: number | null;

  /** Who it's requested for: who added it, or who linked the playlist. */
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

/** A user the list is shared with. */
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
   * When the member accepted. Until then they can see the list, but nothing
   * that reads their watch history (watch sync, picks for a room) counts them:
   * being added isn't consent to share viewing.
   */
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public acceptedAt?: Date | null;

  constructor(init?: Partial<MediaListMember>) {
    Object.assign(this, init);
  }
}

/**
 * A title the job believes everyone on the list has finished. Shown to the
 * owner as a prompt; nothing is removed automatically.
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

  /** Set when the owner keeps it, so it isn't suggested again. */
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public dismissedAt?: Date | null;

  @CreateDateColumn({ type: resolveDbType('datetime') })
  public createdAt: Date;

  constructor(init?: Partial<MediaListWatchSuggestion>) {
    Object.assign(this, init);
  }
}

export default MediaList;
