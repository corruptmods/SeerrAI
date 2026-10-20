import type { MediaServerName } from '@server/lib/plexMatchCheck';
import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import type { MatchKind } from '@server/utils/plexMatch';
import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * A requested title Radarr, Sonarr or Lidarr just imported, waiting to be
 * looked for on one media server (lib/matchWatch). One row a title and
 * server: more episodes of a series imported meanwhile add none. Gone once
 * the server has it right, or its time is up.
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

  /** Looks taken so far. */
  @Column({ type: 'int', default: 0 })
  public attempts: number;

  constructor(init?: Partial<MatchWatch>) {
    Object.assign(this, init);
  }
}

/**
 * - waiting: to go out in the next message
 * - sent: went out in a message
 * - held: past the day's messages; on the Health page, and counted in the
 *   next message
 * - counted: counted in a later message
 * - none: never told (the nightly check had it already, or it was fixed
 *   before it went out)
 */
export type MatchNotice = 'waiting' | 'sent' | 'held' | 'counted' | 'none';

/**
 * A wrong match found on a title just imported: kept after it is fixed, so
 * the same problem is never told twice.
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

  /** When the message it went out in was sent. */
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public sentAt?: Date | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public resolvedAt?: Date | null;

  /** While unresolved: when to look at the server's item again. */
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public nextCheckAt?: Date | null;

  constructor(init?: Partial<MatchProblem>) {
    Object.assign(this, init);
  }
}
