import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import BackfillCandidate from './BackfillCandidate';
import BackfillJob from './BackfillJob';

export type BackfillKind = 'series' | 'movie';

export type BackfillSeriesStatus =
  /** Sonarr or Radarr searched and grabbed nothing; not searched here yet. */
  | 'stuck'
  | 'searching'
  /** Packs found that would help, waiting for an admin. */
  | 'found'
  /** Searched; nothing usable. Searched again after a while. */
  | 'none'
  | 'downloading'
  | 'ignored'
  /** Nothing missing any more. */
  | 'done';

/** A Sonarr series or a Radarr movie Backfill is following. */
@Entity()
@Unique(['kind', 'serverId', 'arrId'])
export class BackfillSeries {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'varchar', default: 'series' })
  public kind: BackfillKind;

  /** The Sonarr or Radarr server's id in Seerr's settings. */
  @Column()
  public serverId: number;

  /** The series' id in Sonarr, or the movie's in Radarr. */
  @Index()
  @Column()
  public arrId: number;

  @Column({ type: 'integer', nullable: true })
  public tvdbId: number | null;

  @Column({ type: 'integer', nullable: true })
  public tmdbId: number | null;

  @Column({ type: 'varchar' })
  public title: string;

  @Column({ type: 'integer', nullable: true })
  public year: number | null;

  @Column({ type: 'varchar', default: 'standard' })
  public seriesType: string;

  /** The poster Sonarr or Radarr has. */
  @Column({ type: 'varchar', nullable: true })
  public poster: string | null;

  @Index()
  @Column({ type: 'varchar', default: 'stuck' })
  public status: BackfillSeriesStatus;

  /** Monitored, aired episodes with no file; 1 for a missing movie. */
  @Column({ default: 0 })
  public missing: number;

  /** Files on disk below the profile's cutoff. */
  @Column({ default: 0 })
  public belowCutoff: number;

  /** Extra names to search under, besides the title and its aliases. */
  @Column({ type: 'simple-json', default: '[]' })
  public searchTerms: string[];

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastArrSearchAt: Date | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastSearchedAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  public searchError: string | null;

  /**
   * When the admin agent looked for this title on its own. It does that
   * once per title, to spare tokens; after that only an admin starts it.
   * Kept here rather than with the conversation, which is cleared out
   * after a while.
   */
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public agentAutoRunAt: Date | null;

  @OneToMany(() => BackfillCandidate, (candidate) => candidate.series)
  public candidates: BackfillCandidate[];

  @OneToMany(() => BackfillJob, (job) => job.series)
  public jobs: BackfillJob[];

  @CreateDateColumn({ type: resolveDbType('datetime') })
  public createdAt: Date;

  @UpdateDateColumn({ type: resolveDbType('datetime') })
  public updatedAt: Date;

  constructor(init?: Partial<BackfillSeries>) {
    Object.assign(this, init);
  }
}

export default BackfillSeries;
