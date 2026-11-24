import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * One play from Silo's playback history, copied here so watch history reads
 * don't walk Silo's history each time. One row per Silo playback session.
 */
@Entity({ name: 'silo_play' })
@Unique(['sessionId'])
@Index(['userId', 'endedAt'])
export class SiloPlay {
  @PrimaryGeneratedColumn()
  public id: number;

  /** Silo's playback session id. */
  @Column({ type: 'varchar' })
  public sessionId: string;

  /** The Silo account that played it. */
  @Column({ type: 'varchar' })
  public userId: string;

  /** The household profile, when Silo recorded one. */
  @Column({ type: 'varchar', nullable: true })
  public profileId?: string | null;

  /** The played item's content id (a movie or an episode). */
  @Column({ type: 'varchar' })
  public itemId: string;

  /**
   * The title it belongs to: the movie, or the episode's series, found when
   * the play was copied (Silo's history doesn't name the series). Null when
   * Silo no longer had the item by then.
   */
  @Index()
  @Column({ type: 'varchar', nullable: true })
  public titleId?: string | null;

  /** 'movie' or 'episode'; empty when Silo no longer knew which. */
  @Column({ type: 'varchar' })
  public kind: string;

  @Column({ type: 'integer', nullable: true })
  public season?: number | null;

  @Column({ type: 'integer', nullable: true })
  public episode?: number | null;

  @Index()
  @DbAwareColumn({ type: 'datetime' })
  public endedAt: Date;

  @Column({ type: 'boolean', default: false })
  public completed: boolean;

  /** How far in it ended, 0 to 100. */
  @Column({ type: 'integer', default: 0 })
  public percent: number;

  /**
   * The movie's or series' title, as Silo named it when the play was copied;
   * kept once the item leaves Silo's catalog.
   */
  @Column({ type: 'varchar', default: '' })
  public title: string;

  /** Who played it as Silo named them: the profile, else the account. */
  @Column({ type: 'varchar', default: '' })
  public viewerName: string;

  constructor(init?: Partial<SiloPlay>) {
    Object.assign(this, init);
  }
}

export default SiloPlay;
