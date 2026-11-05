import type {
  AgentAction,
  AgentRunStatus,
  AgentStep,
  AgentTrigger,
} from '@server/entity/AgentRun';

/** Changes the agent proposed, for an admin to decide on. */
export interface AgentProposal {
  id: string;
  at: string;
  changes: {
    kind: string;
    headline: string;
    details: string[];
  }[];
}

/** A run as the list shows it. */
export interface AgentRunSummary {
  id: number;
  trigger: AgentTrigger;
  status: AgentRunStatus;
  ask: string | null;
  title: string | null;
  kind: 'series' | 'movie' | 'album' | null;
  summary: string | null;
  error: string | null;
  /** Its pending question to an admin. */
  question: string | null;
  actions: AgentAction[];
  steps: number;
  requestedByName: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface AgentRunDetail extends Omit<AgentRunSummary, 'steps'> {
  steps: AgentStep[];
  /** Proposed changes awaiting admin approval. */
  proposal: AgentProposal | null;
  /** Its title's Backfill row id, once known. */
  backfillId: number | null;
  /** Its title's page path, once known. */
  titlePage: string | null;
  inputTokens: number;
  outputTokens: number;
}

export interface AgentOverview {
  /** Why the agent cannot run, or null when it can. */
  problem: string | null;
  autoRun: boolean;
  busy: boolean;
  runs: AgentRunSummary[];
  total: number;
  /** Total finished runs across all pages. */
  finished: number;
}
