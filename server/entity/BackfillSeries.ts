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

export type BackfillKind = 'series' | 'movie' | 'album';

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

/** Something the admin agent did for a title, kept for next time. */
export interface AgentNote {
  /** ISO date. */
  at: string;
  kind: 'searched' | 'grabbed' | 'failed' | 'refused';
  /** The search query, or the release name. */
  what: string;
  /** The episodes it was for: "S08E01". */
  episodes?: string[];
  /** Why it failed or was refused. */
  why?: string;
  /** Result count of a search. */
  results?: number;
}

/** A Sonarr series, a Radarr movie or a Lidarr album Backfill follows. */
@Entity()
@Unique(['kind', 'serverId', 'arrId'])
export class BackfillSeries {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'varchar', default: 'series' })
  public kind: BackfillKind;

  /** The Sonarr, Radarr or Lidarr server's id in Seerr's settings. */
  @Column()
  public serverId: number;

  /** The series' id in Sonarr, the movie's in Radarr, the album's in Lidarr. */
  @Index()
  @Column()
  public arrId: number;

  @Column({ type: 'integer', nullable: true })
  public tvdbId: number | null;

  @Column({ type: 'integer', nullable: true })
  public tmdbId: number | null;

  @Column({ type: 'varchar' })
  public title: string;

  /** An album's MusicBrainz id (its release group), for its page. */
  @Column({ type: 'varchar', nullable: true })
  public foreignId: string | null;

  /** An album's artist, as Lidarr names them. */
  @Column({ type: 'varchar', nullable: true })
  public artistName: string | null;

  /** An album's artist's id in Lidarr. */
  @Column({ type: 'integer', nullable: true })
  public artistArrId: number | null;

  /**
   * Followed by admin choice (its page, Start search, or the admin agent)
   * rather than found by a scan. An unrequested album is only followed this
   * way.
   */
  @Column({ default: false })
  public byHand: boolean;

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
   * When the admin agent last searched this title on its own. It does so once
   * per title to save tokens; after that only an admin starts it. Stored here
   * because conversations are pruned.
   */
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public agentAutoRunAt: Date | null;

  /**
   * What the admin agent tried for this title, oldest first, given to its next
   * conversation about it (see agent/notes.ts). Not selected by default; only
   * read when needed.
   */
  @Column({ type: 'simple-json', default: '[]', select: false })
  public agentNotes: AgentNote[];

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
