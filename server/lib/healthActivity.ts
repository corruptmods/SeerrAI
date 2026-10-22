import { getRepository } from '@server/datasource';
import AgentRun from '@server/entity/AgentRun';
import BackfillJob from '@server/entity/BackfillJob';
import DownloadCheck from '@server/entity/DownloadCheck';
import { aiFeatureOn } from '@server/lib/ai';
import downloadCheck from '@server/lib/downloadCheck';
import { getSettings } from '@server/lib/settings';
import { In, IsNull, MoreThanOrEqual, Not } from 'typeorm';

/*
 * What Download Check and the admin agent did in the last week, for the
 * Health page: enough to see they are working, without opening Backfill.
 * Counts only; what each one was is on the Backfill page.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface DownloadCheckWeek {
  mode: 'off' | 'report' | 'on';
  /** Grabs rejected before they downloaded (or would be, in Report only). */
  rejected: number;
  /** Stuck imports it imported under the right title or episode. */
  imported: number;
  /** Downloads it cleared or dropped. */
  cleared: number;
  /** What it would have done, in Report only. */
  wouldHave: number;
  /** Actions that didn't work. */
  failed: number;
}

export interface AgentWeek {
  /** Conversations started this week. */
  conversations: number;
  /** Downloads it started this week. */
  downloads: number;
  /** Of those, how many imported, and how many failed. */
  imported: number;
  failed: number;
  /** Changes an admin approved and it made (replacements and the like). */
  changes: number;
}

export interface HealthActivity {
  /** Absent while Download Check is off and did nothing this week. */
  downloadCheck?: DownloadCheckWeek;
  /** Absent while the admin agent isn't set up. */
  agent?: AgentWeek;
}

export const healthActivity = async (
  now = Date.now()
): Promise<HealthActivity> => {
  const since = new Date(now - WEEK_MS);
  const activity: HealthActivity = {};

  const checks = getRepository(DownloadCheck);
  const week = await checks.find({
    select: { action: true, status: true },
    where: { createdAt: MoreThanOrEqual(since) },
  });
  const mode = downloadCheck.mode();
  if (mode !== 'off' || week.length) {
    const done = (...actions: string[]) =>
      week.filter((r) => r.status === 'done' && actions.includes(r.action))
        .length;
    activity.downloadCheck = {
      mode,
      rejected: done('reject'),
      imported: done('import'),
      cleared: done('clear', 'drop'),
      wouldHave: week.filter((r) => r.status === 'would').length,
      failed: week.filter((r) => r.status === 'failed').length,
    };
  }

  const settings = getSettings();
  if (settings.backfill.enabled && aiFeatureOn('aiAgent')) {
    const runs = getRepository(AgentRun);
    const jobs = getRepository(BackfillJob);
    const [conversations, recent, started] = await Promise.all([
      runs.count({ where: { createdAt: MoreThanOrEqual(since) } }),
      // Runs that worked this week, for the changes they made this week.
      runs.find({
        select: { id: true, actions: true },
        where: [
          { finishedAt: MoreThanOrEqual(since) },
          { status: In(['queued', 'running', 'waiting']) },
        ],
      }),
      jobs.find({
        select: { id: true, status: true, imported: true },
        where: {
          agentRunId: Not(IsNull()),
          createdAt: MoreThanOrEqual(since),
        },
      }),
    ]);
    const changes = recent
      .flatMap((run) => run.actions ?? [])
      .filter(
        (action) =>
          action.type === 'change' && new Date(action.at).getTime() >= +since
      ).length;
    activity.agent = {
      conversations,
      downloads: started.length,
      imported: started.filter((job) => job.status === 'done' && job.imported)
        .length,
      failed: started.filter((job) => job.status === 'failed').length,
      changes,
    };
  }
  return activity;
};
