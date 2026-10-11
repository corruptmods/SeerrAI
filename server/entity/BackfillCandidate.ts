import type { PlanEntry, PlanSummary } from '@server/lib/backfill/plan';
import {
  DbAwareColumn,
  bigNumber,
  resolveDbType,
} from '@server/utils/DbColumnHelper';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import BackfillSeries from './BackfillSeries';

export type BackfillCandidateStatus =
  /** Inspected and useful: waiting for an admin. */
  | 'ready'
  /** Inspected; nothing in it Backfill would import. */
  | 'rejected'
  | 'approved'
  | 'skipped'
  /** Couldn't be fetched or read. */
  | 'failed'
  /** Approved, then its download failed: never offered again. */
  | 'dead';

/** A pack found for a series, with what it would do file by file. */
@Entity()
export class BackfillCandidate {
  @PrimaryGeneratedColumn()
  public id: number;

  @Index()
  @ManyToOne(() => BackfillSeries, (series) => series.candidates, {
    onDelete: 'CASCADE',
  })
  public series: BackfillSeries;

  @Column()
  public seriesId: number;

  @Column({ type: 'text' })
  public guid: string;

  @Column({ type: 'text' })
  public title: string;

  @Column({ type: 'varchar' })
  public indexer: string;

  @Column({ default: 0 })
  public indexerId: number;

  @Column({ type: 'varchar' })
  public protocol: 'torrent' | 'usenet';

  @Column({ type: 'bigint', default: 0, transformer: bigNumber })
  public size: number;

  @Column({ type: 'integer', nullable: true })
  public seeders: number | null;

  @Column({ type: 'varchar', nullable: true })
  public publishDate: string | null;

  /** Through Prowlarr; carries Prowlarr's key, so it never leaves the server. */
  @Column({ type: 'text', nullable: true })
  public downloadUrl: string | null;

  @Column({ type: 'text', nullable: true })
  public magnetUrl: string | null;

  @Column({ type: 'varchar', nullable: true })
  public infoHash: string | null;

  @Index()
  @Column({ type: 'varchar', default: 'ready' })
  public status: BackfillCandidateStatus;

  /** Why it is rejected or failed. */
  @Column({ type: 'varchar', nullable: true })
  public reason: string | null;

  @Column({ type: 'simple-json', default: '[]' })
  public plan: PlanEntry[];

  @Column({ type: 'simple-json', nullable: true })
  public summary: PlanSummary | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public notifiedAt: Date | null;

  @CreateDateColumn({ type: resolveDbType('datetime') })
  public createdAt: Date;

  @UpdateDateColumn({ type: resolveDbType('datetime') })
  public updatedAt: Date;

  constructor(init?: Partial<BackfillCandidate>) {
    Object.assign(this, init);
  }
}

export default BackfillCandidate;
