import type {
  CheckAction,
  CheckFinding,
  CheckStage,
  CheckStatus,
} from '@server/entity/DownloadCheck';
import type { DownloadCheckMode } from '@server/lib/settings';

/** One finding, as the Backfill page shows it. */
export interface DownloadCheckRow {
  id: number;
  app: 'sonarr' | 'radarr';
  /** The server's name in Settings. */
  server?: string;
  stage: CheckStage;
  /** The release's name. */
  title: string;
  itemId: number;
  itemTitle: string;
  episodes: string;
  poster?: string;
  finding: CheckFinding;
  action: CheckAction;
  status: CheckStatus;
  /** What showing the finding needs: files, hours, qualities, names. */
  params: Record<string, unknown>;
  /** The server's own words, for a stuck import. */
  detail?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DownloadCheckOverview {
  mode: DownloadCheckMode;
  /** The newest, and everything waiting for an admin. */
  rows: DownloadCheckRow[];
  /** Done in the last seven days. */
  week: { rejected: number; imported: number; cleared: number; found: number };
  waiting: number;
}
