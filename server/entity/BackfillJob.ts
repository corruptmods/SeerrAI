import type { PlanEntry } from '@server/lib/backfill/plan';
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

export type BackfillJobStatus =
  /** Approved; waiting for a free slot or disk space. */
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'importing'
  | 'done'
  | 'failed'
  | 'cancelled';

export type BackfillFileState = 'waiting' | 'importing' | 'imported' | 'failed';

export interface BackfillJobFile extends PlanEntry {
  state: BackfillFileState;
  note?: string;
  /** Episode file ids before the import, to tell what it replaced. */
  before?: number[];
}

export interface BackfillLogLine {
  at: string;
  kind: 'info' | 'ok' | 'warn' | 'error';
  message: string;
}

/** An approved pack being downloaded and imported. */
@Entity()
export class BackfillJob {
  @PrimaryGeneratedColumn()
  public id: number;

  @Index()
  @ManyToOne(() => BackfillSeries, (series) => series.jobs, {
    onDelete: 'CASCADE',
  })
  public series: BackfillSeries;

  @Column()
  public seriesId: number;

  @Column({ type: 'integer', nullable: true })
  public candidateId: number | null;

  @Column({ type: 'text' })
  public title: string;

  @Index()
  @Column({ type: 'varchar', default: 'queued' })
  public status: BackfillJobStatus;

  @Column({ type: 'varchar', default: 'missing' })
  public mode: 'missing' | 'all';

  @Column({ type: 'varchar' })
  public protocol: 'torrent' | 'usenet';

  @Column()
  public clientId: number;

  /**
   * Where a running job is within its status, in words: "Waiting for the
   * torrent's file list", SABnzbd's "Repairing", Sonarr importing.
   */
  @Column({ type: 'varchar', nullable: true })
  public stage: string | null;

  /** The torrent's hash or SABnzbd's job id, once added. */
  @Column({ type: 'varchar', nullable: true })
  public downloadId: string | null;

  @Column({ type: 'simple-json', default: '[]' })
  public files: BackfillJobFile[];

  /** Whole percent, 0 to 100. */
  @Column({ type: 'integer', default: 0 })
  public progress: number;

  @Column({ type: 'bigint', default: 0, transformer: bigNumber })
  public size: number;

  @Column({ type: 'bigint', default: 0, transformer: bigNumber })
  public sizeLeft: number;

  @Column({ type: 'integer', default: 0 })
  public speed: number;

  @Column({ type: 'integer', nullable: true })
  public secondsLeft: number | null;

  @Column({ default: 0 })
  public imported: number;

  @Column({ default: 0 })
  public replaced: number;

  @Column({ default: 0 })
  public rejected: number;

  /** Sonarr ManualImport commands in flight. */
  @Column({ type: 'simple-json', default: '[]' })
  public commandIds: number[];

  @Column({ type: 'simple-json', default: '[]' })
  public log: BackfillLogLine[];

  @Column({ type: 'text', nullable: true })
  public error: string | null;

  @Column({ type: 'integer', nullable: true })
  public approvedById: number | null;

  @Column({ type: 'varchar', nullable: true })
  public approvedByName: string | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public startedAt: Date | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public finishedAt: Date | null;

  @CreateDateColumn({ type: resolveDbType('datetime') })
  public createdAt: Date;

  @UpdateDateColumn({ type: resolveDbType('datetime') })
  public updatedAt: Date;

  constructor(init?: Partial<BackfillJob>) {
    Object.assign(this, init);
  }
}

export default BackfillJob;
