import type { MediaServerName } from '@server/lib/plexMatchCheck';
import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import type { MatchKind } from '@server/utils/plexMatch';
import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * A requested title Radarr, Sonarr or Lidarr just imported, awaiting a check on
 * one media server (lib/matchWatch). One row per title and server: more
 * episodes imported meanwhile add none. Removed once the server matches it
 * correctly or time runs out.
 */
@Entity()
@Unique(['mediaId', 'mediaServer', 'arrServerId', 'arrItemId'])
export class MatchWatch {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column()
  public mediaId: number;

  @Column({ type: 'varchar' })
  public kind: MatchKind;

  @Column({ type: 'varchar' })
  public mediaServer: MediaServerName;

  /** Which Radarr, Sonarr or Lidarr imported it. */
  @Column()
  public arrServerId: number;

  /** Radarr's film, Sonarr's series or Lidarr's album. */
  @Column()
  public arrItemId: number;

  /** Music: Lidarr's artist. */
  @Column({ type: 'int', nullable: true })
  public arrArtistId?: number | null;

  @DbAwareColumn({ type: 'datetime' })
  public importedAt: Date;

  @Index()
  @DbAwareColumn({ type: 'datetime' })
  public nextCheckAt: Date;

  /** Checks made so far. */
  @Column({ type: 'int', default: 0 })
  public attempts: number;

  constructor(init?: Partial<MatchWatch>) {
    Object.assign(this, init);
  }
}

/**
 * - waiting: goes out in the next message
 * - sent: went out in a message
 * - held: over the daily message limit; on the Health page and counted in the
 *   next message
 * - counted: counted in a later message
 * - none: never sent (the nightly check had it already, or it was fixed first)
 */
export type MatchNotice = 'waiting' | 'sent' | 'held' | 'counted' | 'none';

/**
 * A wrong match found on a just-imported title, kept after it's fixed so the
 * same problem is never reported twice.
 */
@Entity()
export class MatchProblem {
  @PrimaryGeneratedColumn()
  public id: number;

  /** The media server, the title and what it was matched to (problemKey). */
  @Column({ type: 'varchar', unique: true })
  public key: string;

  @Index()
  @Column({ type: 'int', nullable: true })
  public mediaId?: number | null;

  @Column({ type: 'varchar' })
  public mediaServer: MediaServerName;

  @Column({ type: 'varchar' })
  public kind: MatchKind;

  /** The problem as Match Check describes one (PlexMatchProblem), as JSON. */
  @Column({ type: 'text' })
  public problem: string;

  @Column({ type: 'int', nullable: true })
  public arrServerId?: number | null;

  /** Radarr's film, Sonarr's series or Lidarr's artist. */
  @Column({ type: 'int', nullable: true })
  public arrItemId?: number | null;

  /** Music: Lidarr's album. */
  @Column({ type: 'int', nullable: true })
  public arrAlbumId?: number | null;

  @Column({ type: 'varchar', default: 'waiting' })
  public notice: MatchNotice;

  @DbAwareColumn({ type: 'datetime' })
  public foundAt: Date;

  /** When the message containing it was sent. */
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public sentAt?: Date | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public resolvedAt?: Date | null;

  /** While unresolved: when to recheck the server's item. */
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public nextCheckAt?: Date | null;

  constructor(init?: Partial<MatchProblem>) {
    Object.assign(this, init);
  }
}
