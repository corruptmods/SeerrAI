import type {
  AgentAction,
  AgentRunStatus,
  AgentStep,
  AgentTrigger,
} from '@server/entity/AgentRun';

/** Changes the agent proposed, as an admin sees them to decide on. */
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
  /** What it asked an admin, while it waits. */
  question: string | null;
  actions: AgentAction[];
  steps: number;
  requestedByName: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface AgentRunDetail extends Omit<AgentRunSummary, 'steps'> {
  steps: AgentStep[];
  /** Changes it proposed, waiting for an admin to approve or decline. */
  proposal: AgentProposal | null;
  /** The Backfill row for its title, for a link, once known. */
  backfillId: number | null;
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
  /** How many finished runs there are, on any page. */
  finished: number;
}
