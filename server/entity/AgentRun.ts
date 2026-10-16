import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** Asked by an admin; on its own for a requested title; or for a missing
 * title someone reported. */
export type AgentTrigger = 'ask' | 'auto' | 'report';

/**
 * What a run is for. Work: looking for something, as asked or on its own.
 * Approval: a change asked for on someone's behalf, waiting for an admin.
 * Follow: a replaced season, followed until its new files are in. Retry:
 * work that went on by itself after a download it started failed. An
 * approval or a followed season is not one of the runs it may start in a
 * day, and only work under way holds up another report of the same title.
 */
export type AgentRunPurpose = 'work' | 'approval' | 'follow' | 'retry';

/**
 * Held: for a report, until Sonarr's or Radarr's search and Backfill's are
 * over, and only then if nothing was found. Waiting: it asked an admin
 * something and goes on once answered. A finished run goes on too when an
 * admin replies to it.
 */
export type AgentRunStatus =
  | 'held'
  | 'queued'
  | 'running'
  | 'waiting'
  | 'done'
  | 'failed';

/**
 * One line of what the agent did: what it said, each tool it used and what
 * that showed, and anything it changed.
 */
export interface AgentStep {
  at: string;
  kind:
    | 'say'
    | 'tool'
    | 'result'
    | 'error'
    | 'action'
    /** It asked an admin. */
    | 'ask'
    /** An admin's answer, correction or follow-up. */
    | 'reply'
    /** It proposed changes only an admin can approve. */
    | 'propose'
    /** A download it started failed, and it was told to look again. */
    | 'followUp';
  tool?: string;
  text: string;
}

/**
 * Something the agent changed: a download started, a title requested, or a
 * change an admin approved (a group blocked, a file deleted…).
 */
export interface AgentAction {
  at: string;
  type: 'grab' | 'request' | 'stop' | 'relink' | 'change';
  /** For a change: which kind. */
  change?: string;
  /** For a change: the admin who approved it. */
  approvedBy?: string;
  title: string;
  detail: string;
  jobId?: number;
  /**
   * For a grab: files added to a download already under way (started by
   * Backfill, someone else or another conversation), not one it started.
   */
  extended?: boolean;
  requestId?: number;
  /** The episodes or movie it is for, to keep caps and repeats in check. */
  episodeIds?: number[];
  release?: string;
}

/** One piece of work by the admin agent, with everything it did. */
@Entity()
export class AgentRun {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'varchar' })
  public trigger: AgentTrigger;

  @Column({ type: 'varchar', default: 'work' })
  public purpose: AgentRunPurpose;

  @Index()
  @Column({ type: 'varchar', default: 'queued' })
  public status: AgentRunStatus;

  /** What an admin first asked, in their words. */
  @Column({ type: 'text', nullable: true })
  public ask: string | null;

  /** The title it was about, once known: series or movie, and where. */
  @Column({ type: 'varchar', nullable: true })
  public kind: 'series' | 'movie' | null;

  @Column({ type: 'integer', nullable: true })
  public serverId: number | null;

  @Index()
  @Column({ type: 'integer', nullable: true })
  public arrId: number | null;

  @Column({ type: 'varchar', nullable: true })
  public title: string | null;

  /** Its closing words: what it found and did. */
  @Column({ type: 'text', nullable: true })
  public summary: string | null;

  @Column({ type: 'simple-json', default: '[]' })
  public steps: AgentStep[];

  @Column({ type: 'simple-json', default: '[]' })
  public actions: AgentAction[];

  @Column({ type: 'text', nullable: true })
  public error: string | null;

  /** What it asked, while it waits for an answer. */
  @Column({ type: 'text', nullable: true })
  public question: string | null;

  /**
   * The conversation with the model, so it can go on after an answer or a
   * follow-up, and the releases it had found.
   */
  @Column({ type: 'simple-json', default: '[]' })
  public conversation: unknown[];

  @Column({ type: 'simple-json', default: '{}' })
  public memory: Record<string, unknown>;

  @Column({ type: 'integer', nullable: true })
  public requestedById: number | null;

  @Column({ type: 'varchar', nullable: true })
  public requestedByName: string | null;

  @Column({ type: 'integer', default: 0 })
  public inputTokens: number;

  @Column({ type: 'integer', default: 0 })
  public outputTokens: number;

  @Index()
  @CreateDateColumn({ type: resolveDbType('datetime') })
  public createdAt: Date;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public startedAt: Date | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public finishedAt: Date | null;

  constructor(init?: Partial<AgentRun>) {
    Object.assign(this, init);
  }
}

export default AgentRun;
