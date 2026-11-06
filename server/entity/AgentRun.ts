import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Asked by an admin; automatic for a requested title; or for a reported missing
 * title.
 */
export type AgentTrigger = 'ask' | 'auto' | 'report';

/**
 * What a run is for. Work: searching, as asked or automatically. Approval: a
 * change requested on someone's behalf, awaiting an admin. Follow: a replaced
 * season, tracked until its new files arrive. Retry: work resumed automatically
 * after a download it started failed. Approvals and follows don't count towards
 * the daily run limit, and only in-progress work blocks another report of the
 * same title.
 */
export type AgentRunPurpose = 'work' | 'approval' | 'follow' | 'retry';

/**
 * Held: a report waits until Sonarr's or Radarr's search and Backfill's finish,
 * and proceeds only if nothing was found. Waiting: it asked an admin and
 * resumes once answered. A finished run also resumes when an admin replies.
 */
export type AgentRunStatus =
  | 'held'
  | 'queued'
  | 'running'
  | 'waiting'
  | 'done'
  | 'failed';

/**
 * One step of the agent's log: what it said, each tool call and its result, and
 * anything it changed.
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
  /** On a reply: an admin's approval or decline of a proposal. */
  decision?: boolean;
}

/**
 * Something the agent changed: a download started, a title requested, or an
 * admin-approved change (a group blocked, a file deleted…).
 */
export interface AgentAction {
  at: string;
  type: 'grab' | 'request' | 'stop' | 'relink' | 'change';
  /** For a change: its kind. */
  change?: string;
  /** For a change: the approving admin. */
  approvedBy?: string;
  title: string;
  detail: string;
  jobId?: number;
  /**
   * For a grab: files added to a download already in progress (started by
   * Backfill, someone else or another conversation), not one it started.
   */
  extended?: boolean;
  requestId?: number;
  /** The episodes or movie it's for, to enforce caps and avoid repeats. */
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

  /** The admin's original request, verbatim. */
  @Column({ type: 'text', nullable: true })
  public ask: string | null;

  /** The title's kind once known: series, movie or album. */
  @Column({ type: 'varchar', nullable: true })
  public kind: 'series' | 'movie' | 'album' | null;

  @Column({ type: 'integer', nullable: true })
  public serverId: number | null;

  @Index()
  @Column({ type: 'integer', nullable: true })
  public arrId: number | null;

  @Column({ type: 'varchar', nullable: true })
  public title: string | null;

  /** Its closing summary: what it found and did. */
  @Column({ type: 'text', nullable: true })
  public summary: string | null;

  @Column({ type: 'simple-json', default: '[]' })
  public steps: AgentStep[];

  @Column({ type: 'simple-json', default: '[]' })
  public actions: AgentAction[];

  @Column({ type: 'text', nullable: true })
  public error: string | null;

  /** Its question, while awaiting an answer. */
  @Column({ type: 'text', nullable: true })
  public question: string | null;

  /**
   * The model conversation, so it can resume after an answer or follow-up, plus
   * the releases it found.
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
