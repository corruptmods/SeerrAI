import type {
  CheckAction,
  CheckFinding,
  CheckStage,
  CheckStatus,
} from '@server/entity/DownloadCheck';
import type { DownloadCheckMode } from '@server/lib/settings';

/** One finding on the Backfill page. */
export interface DownloadCheckRow {
  id: number;
  app: 'sonarr' | 'radarr';
  /** Server name from Settings. */
  server?: string;
  stage: CheckStage;
  /** Release name. */
  title: string;
  itemId: number;
  itemTitle: string;
  episodes: string;
  poster?: string;
  finding: CheckFinding;
  action: CheckAction;
  status: CheckStatus;
  /** Values for rendering the finding: files, hours, qualities, names. */
  params: Record<string, unknown>;
  /** The server's message for a stuck import. */
  detail?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DownloadCheckOverview {
  mode: DownloadCheckMode;
  /** The newest, plus everything awaiting an admin. */
  rows: DownloadCheckRow[];
  /** Counts for the last seven days. */
  week: { rejected: number; imported: number; cleared: number; found: number };
  waiting: number;
}
