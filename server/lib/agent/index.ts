import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import type { AgentStep } from '@server/entity/AgentRun';
import AgentRun from '@server/entity/AgentRun';
import BackfillJob from '@server/entity/BackfillJob';
import BackfillSeries from '@server/entity/BackfillSeries';
import Issue from '@server/entity/Issue';
import IssueComment from '@server/entity/IssueComment';
import { MediaEventType } from '@server/entity/MediaEvent';
import { User } from '@server/entity/User';
import type { Proposal, ProposedChange } from '@server/lib/agent/changes';
import { applyChange, applySeasonChange } from '@server/lib/agent/changes';
import {
  PAST_LIMIT,
  SYSTEM,
  TURN_TOKENS,
  answerCalls,
  compact,
  describe,
} from '@server/lib/agent/conversation';
import type { AgentNote } from '@server/lib/agent/notes';
import {
  addNotes,
  describeNotes,
  noteOfCall,
  notesOf,
} from '@server/lib/agent/notes';
import { episodeLabel, rangeLabel } from '@server/lib/agent/rules';
import type {
  AgentState,
  KnownRelease,
  MadeCall,
  TitleRef,
} from '@server/lib/agent/tools';
import {
  TOOLS,
  adminPresent,
  boundTitle,
  decisionText,
  notLookedFor,
  readTitleRef,
  runTool,
  startApprovedGrab,
  titleRef,
} from '@server/lib/agent/tools';
import { aiFeatureOn, modelFor } from '@server/lib/ai';
import { countAnswer, noteFailure } from '@server/lib/ai/credit';
import type {
  ConverseMessage,
  ConverseRequest,
  ConverseTurn,
  ToolResult,
} from '@server/lib/ai/providers';
import { converse, isOutage, listModels } from '@server/lib/ai/providers';
import type { AgentHandBack } from '@server/lib/backfill/engine';
import backfill, {
  jobEpisodes,
  startedByAgent,
} from '@server/lib/backfill/engine';
import { releaseGroup } from '@server/lib/backfill/naming';
import backfillNotices from '@server/lib/backfill/notices';
import { requestedSince } from '@server/lib/backfill/schedule';
import { recordMediaEvent } from '@server/lib/mediaHistory';
import notificationManager, { Notification } from '@server/lib/notifications';
import { adminAgentEvent } from '@server/lib/notifications/eventTitles';
import { owner } from '@server/lib/owner';
import { Permission } from '@server/lib/permissions';
import type { AiSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isAxiosError } from 'axios';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { FindOptionsWhere } from 'typeorm';
import { In, LessThan, MoreThan } from 'typeorm';

/*
 * The admin agent: a model with an admin's tools for getting a stuck title
 * downloaded. It starts on its own for a requested title Backfill's search
 * found nothing usable for, and when an admin asks it something. One run at
 * a time; each keeps every step, and admins are told of any download.
 *
 * The model decides what to try; the tools decide what it may change. On
 * its own: only missing episodes, within size and daily limits, in English
 * or the title's original language. Anything more (replacing a file,
 * blocking a release group, deleting files, marking a download failed,
 * changing a profile) it only proposes, and nothing happens until an admin
 * approves.
 */

export { answerCalls, compact } from '@server/lib/agent/conversation';

const LABEL = 'Agent';
/** Max tool calls per turn; more would hammer the indexers. */
const MAX_CALLS_PER_TURN = 12;
const readOnly = (name: string) =>
  !!TOOLS.find((tool) => tool.name === name)?.readOnly;
const DAY = 24 * 60 * 60 * 1000;
const MAX_ASK = 1000;
const MAX_STEPS_KEPT = 400;
/** How often old conversations are cleared out. */
const PURGE_EVERY_MS = 6 * 60 * 60 * 1000;
const FINISHED: AgentRun['status'][] = ['done', 'failed'];
/** How often held reports are checked. */
const HOLD_CHECK_MS = 60 * 1000;
/** Longest a report is held for searches still running. */
const HOLD_LONGEST_MS = 6 * 60 * 60 * 1000;
/**
 * Waits between retries within a run while the AI service is unreachable,
 * busy or too slow: about eight minutes in all.
 */
const OUTAGE_WAITS_MS = [15_000, 30_000, 60_000, 120_000, 240_000];
/**
 * A run that failed that way resumes once the service answers: checked this
 * often, for up to a day after the run first lost it.
 */
const OUTAGE_CHECK_MS = 5 * 60 * 1000;
const OUTAGE_LONGEST_MS = DAY;
/** How long a replaced season is followed for its new files to import. */
const FOLLOW_LONGEST_MS = 2 * 24 * 60 * 60 * 1000;
const UNFINISHED: AgentRun['status'][] = [
  'held',
  'queued',
  'running',
  'waiting',
];
/**
 * When a run waiting on the AI service first lost it. `lostSince` stays on
 * a resumed run, so losing it again doesn't restart its day.
 */
const outageOf = (run: AgentRun) =>
  (run.memory as { outage?: { since: string } } | null)?.outage;
const lostSince = (run: AgentRun): string | undefined =>
  outageOf(run)?.since ??
  (run.memory as { lostSince?: string } | null)?.lostSince;
const withoutOutage = (run: AgentRun): AgentRun['memory'] => {
  const {
    outage: _outage,
    lostSince: _since,
    ...rest
  } = (run.memory ?? {}) as { outage?: unknown; lostSince?: unknown };
  void _outage;
  void _since;
  return rest;
};

/**
 * How many replacements of a failed download (same episodes) may fail in a
 * day before the agent stops and tells admins.
 */
const MAX_FAILED_REPLACEMENTS = 3;
/**
 * Purposes that count toward the runs it starts in a day. A run continued
 * after a failed download is still the same run.
 */
const COUNTED: AgentRun['purpose'][] = ['work', 'retry'];
const SEARCH_COMMANDS = new Set([
  'EpisodeSearch',
  'SeasonSearch',
  'SeriesSearch',
  'MissingEpisodeSearch',
  'MoviesSearch',
]);

/** An admin's answer to a proposal, carried out when the run resumes. */
interface Decision {
  by: string;
  changes: ProposedChange[];
}

export const proposalOf = (run: AgentRun): Proposal | undefined =>
  (run.memory as { proposal?: Proposal } | null)?.proposal;

/** Says what an admin approved that the run never got to. */
const notDone = (decision: Decision): string =>
  `What ${decision.by} approved was not done: ${decision.changes
    .map((c) => c.headline)
    .join('; ')}. Reply to have it proposed again.`;

/** A run keeps only its newest steps. */
const trimSteps = (run: AgentRun): void => {
  if (run.steps.length > MAX_STEPS_KEPT) {
    run.steps.splice(0, run.steps.length - MAX_STEPS_KEPT);
  }
};

/** Count of downloads these runs started since `since`. */
const grabsSince = (runs: Pick<AgentRun, 'actions'>[], since: number) =>
  runs.reduce(
    (n, r) =>
      n +
      r.actions.filter(
        (a) => a.type === 'grab' && new Date(a.at).getTime() > since
      ).length,
    0
  );

/** The report a run came from, kept with it. */
interface ReportMemory {
  issueId?: number;
  seasonNumber?: number;
  /** Reported by an admin: their ask, not the agent acting on its own. */
  byAdmin?: boolean;
  /**
   * The issue has been answered; an admin's later follow-ups stay between
   * them and the agent.
   */
  answered?: boolean;
  /** The files exist but are bad: replace, don't fill. */
  replace?: boolean;
  /**
   * Not a search: a replaced season, followed until its new files import,
   * to tell whoever reported it.
   */
  follow?: { episodeIds: number[] };
}

/** A run that asked an admin directly from a report, without the model. */
interface DirectMemory {
  /** On approval the change is made and the run ends; no model is asked. */
  direct?: boolean;
}

const directOf = (run: AgentRun): boolean =>
  !!(run.memory as DirectMemory | null)?.direct && !run.conversation.length;

/** Failed downloads it started and was told to look again for. */
interface FollowUpMemory {
  /** Told but not yet settled (replaced, or nothing else found). */
  lookingFor?: number[];
}

const lookingForOf = (run: AgentRun): number[] =>
  (run.memory as FollowUpMemory | null)?.lookingFor ?? [];

/**
 * What a download was for: "S06E03", "S06E01-E02, S06E05", "the movie" or
 * "4 tracks".
 */
const jobWhat = (job: BackfillJob, kind: AgentRun['kind']): string =>
  kind === 'movie'
    ? 'the movie'
    : kind === 'album'
      ? job.files.length === 1
        ? '1 track'
        : `${job.files.length} tracks`
      : [
          ...new Set(
            job.files.map((f) =>
              rangeLabel(
                f.season ?? 0,
                f.episodeIds.map((_, i) => (f.episode ?? 0) + i)
              )
            )
          ),
        ].join(', ');

/** Runs among these with a Backfill download they started still running. */
const downloading = async (runs: AgentRun[]): Promise<Set<number>> => {
  const byJob = new Map<number, number>();
  for (const run of runs) {
    for (const action of run.actions) {
      if (action.type === 'grab' && action.jobId)
        byJob.set(action.jobId, run.id);
    }
  }
  if (!byJob.size) return new Set();
  const going = await getRepository(BackfillJob).find({
    select: { id: true },
    where: {
      id: In([...byJob.keys()]),
      status: In(['queued', 'downloading', 'paused', 'importing']),
    },
  });
  return new Set(going.map((job) => byJob.get(job.id)!));
};

/**
 * Deletes finished conversations matching `where`, except those with
 * downloads still running: a conversation isn't over until they import or
 * fail.
 */
const deleteFinished = async (
  where: FindOptionsWhere<AgentRun>
): Promise<number> => {
  const repo = getRepository(AgentRun);
  const finished = await repo.find({
    select: { id: true, actions: true },
    where: { ...where, status: In(FINISHED) },
  });
  const keep = await downloading(finished);
  const ids = finished.map((r) => r.id).filter((id) => !keep.has(id));
  if (!ids.length) return 0;
  const result = await repo.delete({ id: In(ids) });
  await stopLooking(ids);
  return result.affected ?? ids.length;
};

/**
 * Clears the follow-up on failed downloads of deleted conversations, since
 * nothing will look again for them.
 */
const stopLooking = (runIds: number[]) =>
  getRepository(BackfillJob).update(
    { agentRunId: In(runIds), followUp: 'agent' },
    { followUp: 'none' }
  );

/** Whether the agent has already run on its own for this title. */
const triedOn = async (title: {
  kind: 'series' | 'movie' | 'album';
  serverId: number;
  arrId: number;
}): Promise<boolean> =>
  !!(
    await getRepository(BackfillSeries).findOne({
      select: { id: true, agentAutoRunAt: true },
      where: title,
    })
  )?.agentAutoRunAt;

const reportOf = (run: AgentRun): ReportMemory =>
  ((run.memory ?? {}) as { report?: ReportMemory }).report ?? {};

/** A series, movie or album, as runs are keyed. */
interface AgentTitle {
  kind: 'series' | 'movie' | 'album';
  serverId: number;
  arrId: number;
}

const sameTitle = (title: AgentTitle): AgentTitle => ({
  kind: title.kind,
  serverId: title.serverId,
  arrId: title.arrId,
});

/** A conversation that doesn't exist (deleted, or never did). */
export class NoSuchRun extends Error {}

/** What admins said or did to a run while it works. */
interface Live {
  /** Who stopped it; it stops before its next step. */
  stopBy?: string;
  /** Admins' messages, read before its next step. */
  notes: { by: string; text: string }[];
}

/** Max notes waiting to be read at once. */
const MAX_NOTES = 10;

/** An ask for everything missing, not one particular thing. */
const BROAD_ASK =
  /\b(missing|whatever|everything|all of it|the rest|complete)\b/i;

class Agent {
  private queue: number[] = [];
  private running = false;
  private live = new Map<number, Live>();
  /** The run being worked on. */
  private current?: number;
  private started = false;
  private purgeTimer?: NodeJS.Timeout;
  private holdTimer?: NodeJS.Timeout;
  private checkingHeld = false;
  /** When the AI service was last checked for answering again. */
  private outageCheckedAt = 0;
  /** Overridden only by tests, which can't wait minutes. */
  public outageWaitsMs = OUTAGE_WAITS_MS;

  /** Resumes after a restart and subscribes to Backfill's empty searches. */
  public async init(): Promise<void> {
    if (this.started) return;
    this.started = true;
    backfill.onNothingFound = (row) => {
      this.afterEmptySearch(row).catch((e) =>
        logger.warn('Could not start the admin agent', {
          label: LABEL,
          title: row.title,
          errorMessage: e instanceof Error ? e.message : String(e),
        })
      );
    };
    const runs = getRepository(AgentRun);
    await runs.update(
      { status: 'running' },
      {
        status: 'failed',
        error: 'Seerr restarted while it was working.',
        finishedAt: new Date(),
      }
    );
    const waiting = await runs.find({
      where: { status: 'queued' },
      order: { id: 'ASC' },
    });
    this.queue.push(...waiting.map((run) => run.id));
    void this.pump();
    const purge = () =>
      this.purge().catch((e) =>
        logger.warn('Could not clear out old admin agent conversations', {
          label: LABEL,
          errorMessage: e instanceof Error ? e.message : String(e),
        })
      );
    void purge();
    this.purgeTimer = setInterval(purge, PURGE_EVERY_MS);
    this.purgeTimer.unref();
    const checkFailed = (e: unknown) =>
      logger.warn('Could not check on held or interrupted conversations', {
        label: LABEL,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    this.holdTimer = setInterval(() => {
      this.checkHeld().catch(checkFailed);
      this.checkOutages().catch(checkFailed);
    }, HOLD_CHECK_MS);
    this.holdTimer.unref();
  }

  /**
   * After a title is reported missing and Sonarr's or Radarr's and
   * Backfill's searches have started, holds a run that looks further if
   * they find nothing. Only when it may run on its own and isn't already
   * on the title.
   */
  public async afterReport(report: {
    kind: 'series' | 'movie';
    serverId: number;
    arrId: number;
    title: string;
    reporter: User;
    issueId?: number;
    seasonNumber?: number;
    /** The files exist but are bad, and should be replaced. */
    replace?: boolean;
  }): Promise<AgentRun | null> {
    const settings = getSettings().backfill;
    if (!settings.agent.autoRun) return null;
    if (this.problem(await owner())) return null;
    const runs = getRepository(AgentRun);
    const title = {
      kind: report.kind,
      serverId: report.serverId,
      arrId: report.arrId,
    };
    // Only active work blocks a report, not a change awaiting an admin, a
    // followed season, or a retry on its own.
    if (
      await runs.count({
        where: { ...title, status: In(UNFINISHED), purpose: 'work' },
      })
    ) {
      return null;
    }
    // An admin's report is an ask; anyone else's starts the agent on its
    // own, which happens once per title.
    const byAdmin = report.reporter.hasPermission(Permission.ADMIN);
    if (!byAdmin && (await triedOn(title))) return null;
    if ((await this.runsToday()) >= settings.agent.maxAutoRunsPerDay) {
      return null;
    }
    const run = await runs.save(
      new AgentRun({
        trigger: 'report',
        status: 'held',
        ...title,
        title: report.title,
        ask: `${report.replace ? 'Reported bad, to be replaced' : 'Reported missing'}${
          report.seasonNumber !== undefined
            ? ` (season ${report.seasonNumber})`
            : ''
        }`,
        requestedByName: report.reporter.displayName,
        memory: {
          report: {
            issueId: report.issueId,
            seasonNumber: report.seasonNumber,
            byAdmin,
            ...(report.replace ? { replace: true } : {}),
          },
        },
        steps: [],
        actions: [],
      })
    );
    return run;
  }

  /**
   * Proposes a change to admins on someone's behalf, without the model: a
   * run awaiting approval, announced like any proposal. Approved, the change
   * is made and the run ends; declined, nothing happens. Null when the agent
   * cannot work, so nobody could approve it.
   */
  public async awaitApproval(input: {
    title: TitleRef;
    name: string;
    change: ProposedChange;
    reporter: User;
    issueId?: number;
    seasonNumber?: number;
    /** Their request, in their words. */
    ask: string;
  }): Promise<AgentRun | null> {
    if (this.problem(await owner())) return null;
    const proposal: Proposal = {
      id: randomUUID(),
      at: new Date().toISOString(),
      changes: [input.change],
    };
    const now = new Date();
    const run = await getRepository(AgentRun).save(
      new AgentRun({
        trigger: 'report',
        purpose: 'approval',
        status: 'waiting',
        ...input.title,
        title: input.name,
        ask: input.ask.trim().slice(0, MAX_ASK),
        requestedByName: input.reporter.displayName,
        question: `Waiting for approval: ${input.change.headline}.`,
        memory: {
          proposal,
          direct: true,
          report: {
            issueId: input.issueId,
            seasonNumber: input.seasonNumber,
            byAdmin: input.reporter.hasPermission(Permission.ADMIN),
            replace: true,
          },
        },
        steps: [
          {
            at: now.toISOString(),
            kind: 'propose',
            text: input.change.headline,
          },
        ],
        actions: [],
        startedAt: now,
        finishedAt: now,
      })
    );
    await this.tell(run, []).catch(() => undefined);
    return run;
  }

  /**
   * Follows a replaced season until its new files import, then says so on
   * the reported issue. Checked with the held reports.
   */
  public async follow(input: {
    title: TitleRef;
    name: string;
    reporter?: User | null;
    issueId?: number;
    seasonNumber: number;
    episodeIds: number[];
  }): Promise<AgentRun | null> {
    if (!input.episodeIds.length) return null;
    return getRepository(AgentRun).save(
      new AgentRun({
        trigger: 'report',
        purpose: 'follow',
        status: 'held',
        ...input.title,
        title: input.name,
        ask: `Replaced season ${input.seasonNumber}: following it until the new files are in`,
        requestedByName: input.reporter?.displayName ?? null,
        memory: {
          report: {
            issueId: input.issueId,
            seasonNumber: input.seasonNumber,
            byAdmin: !!input.reporter?.hasPermission(Permission.ADMIN),
            follow: { episodeIds: input.episodeIds },
          },
        },
        steps: [],
        actions: [],
      })
    );
  }

  /**
   * Resumes runs that failed because the AI service was unreachable, once it
   * answers again. Checked every few minutes at no cost, for a day after
   * each first lost it.
   */
  public async checkOutages(now = Date.now()): Promise<void> {
    if (now - this.outageCheckedAt < OUTAGE_CHECK_MS) return;
    this.outageCheckedAt = now;
    const runs = getRepository(AgentRun);
    const lost = (
      await runs.find({
        where: {
          status: 'failed',
          finishedAt: MoreThan(new Date(now - OUTAGE_LONGEST_MS)),
        },
      })
    ).filter((run) => outageOf(run));
    if (!lost.length) return;
    const ai = getSettings().ai;
    if (!ai.enabled) return;
    try {
      await listModels(ai);
    } catch (e) {
      logger.debug('The AI service still does not answer', {
        label: LABEL,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    for (const run of lost) {
      const since = outageOf(run)!.since;
      if (now - new Date(since).getTime() > OUTAGE_LONGEST_MS) {
        run.memory = withoutOutage(run);
        await runs.save(run);
        continue;
      }
      run.steps.push({
        at: new Date(now).toISOString(),
        kind: 'error',
        text: 'The AI service answers again, so it carries on.',
      });
      // Only if still failed: an admin may have replied meanwhile.
      const queued = await runs.update(
        { id: run.id, status: 'failed' },
        { status: 'queued', error: null }
      );
      if (!queued.affected) continue;
      run.memory = { ...withoutOutage(run), lostSince: since };
      run.status = 'queued';
      run.error = null;
      await runs.save(run);
      this.queue.push(run.id);
    }
    void this.pump();
  }

  /**
   * One model turn, retried while the service is unreachable, busy or too
   * slow. Null when an admin stopped the run meanwhile.
   */
  private async turnOf(
    runId: number,
    ai: AiSettings,
    req: ConverseRequest,
    note: (text: string) => Promise<void>
  ): Promise<ConverseTurn | null> {
    for (let tries = 0; ; tries++) {
      try {
        return await converse(ai, req);
      } catch (e) {
        const wait = this.outageWaitsMs[tries];
        if (!isOutage(e) || wait === undefined) throw e;
        const seconds = Math.round(wait / 1000);
        await note(
          `${e.message.replace(/\.$/, '')}. Trying again in ${
            seconds < 60
              ? `${seconds} seconds`
              : `${Math.round(seconds / 60)} minute${seconds >= 120 ? 's' : ''}`
          }.`
        );
        const until = Date.now() + wait;
        while (Date.now() < until) {
          if (this.live.get(runId)?.stopBy) return null;
          await sleep(Math.min(1000, until - Date.now()));
        }
        if (this.live.get(runId)?.stopBy) return null;
      }
    }
  }

  /** Checks every held report; one check at a time. */
  public async checkHeld(now = Date.now()): Promise<void> {
    if (this.checkingHeld) return;
    this.checkingHeld = true;
    try {
      const runs = getRepository(AgentRun);
      for (const run of await runs.find({ where: { status: 'held' } })) {
        let verdict:
          | { go: true }
          | { wait: true }
          | { notNeeded: string }
          | { failed: string };
        try {
          verdict = await this.holdVerdict(run, now);
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          verdict = this.cannotCheck(run, now, e, why) ?? { wait: true };
          if ('wait' in verdict) {
            logger.debug('Could not check on a reported title', {
              label: LABEL,
              runId: run.id,
              errorMessage: why,
            });
          }
        }
        if ('wait' in verdict) continue;
        // Only if still held: an admin may have replied during the check,
        // and their reply stands.
        const held = { id: run.id, status: 'held' as const };
        // A followed season tells its reporter how it ended.
        const following = !!reportOf(run).follow;
        if ('notNeeded' in verdict) {
          const settled = await runs.update(held, {
            status: 'done',
            summary: verdict.notNeeded,
            finishedAt: new Date(),
          });
          if (following && settled.affected) {
            await this.comment(run, `Automatic fix: ${verdict.notNeeded}`);
          }
          continue;
        }
        if ('failed' in verdict) {
          const settled = await runs.update(held, {
            status: 'failed',
            error: verdict.failed.slice(0, 500),
            finishedAt: new Date(),
          });
          if (following && settled.affected) {
            await this.comment(run, `Automatic fix: ${verdict.failed}`);
          }
          continue;
        }
        const queued = await runs.update(held, { status: 'queued' });
        if (queued.affected) this.queue.push(run.id);
      }
      void this.pump();
    } finally {
      this.checkingHeld = false;
    }
  }

  /**
   * Gives up a held report that couldn't be checked when its title or
   * server is gone, or it has been held the maximum time. Otherwise null,
   * to retry at the next check.
   */
  private cannotCheck(
    run: AgentRun,
    now: number,
    error: unknown,
    why: string
  ): { failed: string } | null {
    const servers =
      run.kind === 'movie' ? getSettings().radarr : getSettings().sonarr;
    const serverGone = !servers.some((s) => s.id === (run.serverId ?? 0));
    const titleGone = isAxiosError(error) && error.response?.status === 404;
    if (serverGone || titleGone) {
      return {
        failed: `Not looked into: ${
          serverGone
            ? `that ${run.kind === 'movie' ? 'Radarr' : 'Sonarr'} server is no longer set up`
            : `${run.kind === 'movie' ? 'Radarr' : 'Sonarr'} no longer has the title`
        }.`,
      };
    }
    const longest = reportOf(run).follow ? FOLLOW_LONGEST_MS : HOLD_LONGEST_MS;
    if (now - new Date(run.createdAt).getTime() >= longest) {
      return {
        failed: `Not looked into: it could not be checked on for ${
          longest / (60 * 60 * 1000)
        } hours (${why}).`,
      };
    }
    return null;
  }

  /**
   * Whether a replaced season is back: every episode grabbed for has a file
   * again. Given up after two days.
   */
  private async followVerdict(
    run: AgentRun,
    follow: { episodeIds: number[] },
    now: number
  ): Promise<{ wait: true } | { notNeeded: string } | { failed: string }> {
    const { seasonNumber } = reportOf(run);
    const season = seasonNumber !== undefined ? `Season ${seasonNumber}` : 'It';
    const episodes = await backfill
      .sonarrFor(run.serverId ?? 0)
      .getSeriesEpisodes(run.arrId ?? 0);
    const waiting = follow.episodeIds
      .map((id) => episodes.find((ep) => ep.id === id))
      .filter((ep): ep is NonNullable<typeof ep> => !!ep && !ep.hasFile);
    if (!waiting.length) {
      const count = follow.episodeIds.length;
      return {
        notNeeded: `${season} of ${run.title ?? 'the series'} is back: ${
          count === 1 ? 'its new file has' : `all ${count} new files have`
        } been imported.`,
      };
    }
    if (now - new Date(run.createdAt).getTime() < FOLLOW_LONGEST_MS) {
      return { wait: true };
    }
    const names = waiting
      .slice(0, 12)
      .map((ep) => episodeLabel(ep.seasonNumber, ep.episodeNumber))
      .join(', ');
    return {
      failed: `${season} of ${run.title ?? 'the series'} is not all back after two days: ${names} still ${
        waiting.length === 1 ? 'has' : 'have'
      } no file. An admin can see what happened to the download in Sonarr.`,
    };
  }

  /**
   * Whether a held report goes ahead: not while Sonarr, Radarr or Backfill
   * is still searching (for a few hours at most), not when either found
   * something, and not when nothing is missing now.
   */
  private async holdVerdict(
    run: AgentRun,
    now: number
  ): Promise<
    { go: true } | { wait: true } | { notNeeded: string } | { failed: string }
  > {
    const report = reportOf(run);
    if (report.follow) return this.followVerdict(run, report.follow, now);
    // Bad files to replace: Sonarr's search is already over, and nothing is
    // missing to wait for.
    if (report.replace) return { go: true };
    const young = now - new Date(run.createdAt).getTime() < HOLD_LONGEST_MS;
    const { seasonNumber } = report;
    const serverId = run.serverId ?? 0;
    const arrId = run.arrId ?? 0;
    const row = await getRepository(BackfillSeries).findOne({
      where: { kind: run.kind ?? 'series', serverId, arrId },
    });
    if (run.kind === 'movie') {
      const radarr = backfill.radarrFor(serverId);
      if (young) {
        const searching = (await radarr.getCommands()).some(
          (c) =>
            SEARCH_COMMANDS.has(c.name) &&
            (c.status === 'queued' || c.status === 'started') &&
            (c.body?.movieIds ?? []).includes(arrId)
        );
        if (searching || (row && backfill.isSearching(row.id))) {
          return { wait: true };
        }
      }
      const movie = await radarr.getMovieDetail(arrId);
      if (movie.hasFile) {
        return { notNeeded: 'Not needed: Radarr has it now.' };
      }
      if ((await radarr.getMovieQueueCount(arrId)) > 0) {
        return {
          notNeeded: 'Not needed: Radarr found it and is downloading it.',
        };
      }
    } else {
      const sonarr = backfill.sonarrFor(serverId);
      const episodes = await sonarr.getSeriesEpisodes(arrId);
      if (young) {
        const ids = new Set(episodes.map((ep) => ep.id));
        const searching = (await sonarr.getCommands()).some(
          (c) =>
            SEARCH_COMMANDS.has(c.name) &&
            (c.status === 'queued' || c.status === 'started') &&
            (c.body?.seriesId === arrId ||
              (c.body?.episodeIds ?? []).some((id) => ids.has(id)))
        );
        if (searching || (row && backfill.isSearching(row.id))) {
          return { wait: true };
        }
      }
      const queued = new Set(
        await sonarr.getSeriesQueueEpisodes(arrId).catch(() => [] as number[])
      );
      const missing = episodes.filter(
        (ep) =>
          ep.monitored &&
          !ep.hasFile &&
          ep.seasonNumber > 0 &&
          (seasonNumber === undefined || ep.seasonNumber === seasonNumber) &&
          !!ep.airDateUtc &&
          new Date(ep.airDateUtc).getTime() <= now &&
          !queued.has(ep.id)
      );
      if (!missing.length) {
        return {
          notNeeded: queued.size
            ? 'Not needed: Sonarr found what was missing and is downloading it.'
            : 'Not needed: nothing is missing now.',
        };
      }
    }
    if (row?.status === 'found') {
      return {
        notNeeded:
          "Not needed: Backfill found a release, which waits for an admin's approval on the Backfill page.",
      };
    }
    if (row?.status === 'downloading') {
      return { notNeeded: 'Not needed: Backfill is downloading it.' };
    }
    return { go: true };
  }

  /**
   * Deletes finished conversations older than the days kept. Conversations
   * awaiting an answer stay; downloaded files are not touched.
   */
  public async purge(now = Date.now()): Promise<number> {
    const days = getSettings().backfill.agent.keepDays;
    if (!days) return 0;
    const deleted = await deleteFinished({
      finishedAt: LessThan(new Date(now - days * DAY)),
    });
    if (deleted) {
      logger.info(`Cleared out ${deleted} old admin agent conversations`, {
        label: LABEL,
      });
    }
    return deleted;
  }

  /** Deletes one conversation, unless it is working or downloading. */
  public async remove(id: number): Promise<boolean> {
    const runs = getRepository(AgentRun);
    const run = await runs.findOne({ where: { id } });
    if (!run) return false;
    if (run.status === 'queued' || run.status === 'running') {
      throw new Error('It is working on this one; delete it once it is done.');
    }
    if ((await downloading([run])).size) {
      throw new Error(
        'Its downloads are still going; delete it once they have imported or failed.'
      );
    }
    await runs.delete({ id });
    await stopLooking([id]);
    return true;
  }

  /**
   * Deletes every finished conversation, except those awaiting an answer or
   * with downloads still running.
   */
  public async clearFinished(): Promise<number> {
    return deleteFinished({});
  }

  /** Why the agent cannot work for this user now, or null. */
  public problem(user?: User | null): string | null {
    if (!aiFeatureOn('aiAgent', user)) {
      return 'The admin agent needs AI set up, with Admin Agent turned on, in Settings → AI.';
    }
    const ready = backfill.readiness();
    return ready.ready ? null : (ready.problem ?? 'Backfill is not ready.');
  }

  /**
   * An admin's ask, about any title, or from a title's page about that one,
   * binding the run to it from the start.
   */
  public async ask(
    text: string,
    user: User,
    about?: { title: TitleRef; name: string }
  ): Promise<AgentRun> {
    const problem = this.problem(user);
    if (problem) throw new Error(problem);
    const run = await getRepository(AgentRun).save(
      new AgentRun({
        trigger: 'ask',
        status: 'queued',
        ask: text.trim().slice(0, MAX_ASK),
        requestedById: user.id,
        requestedByName: user.displayName,
        ...(about
          ? {
              kind: about.title.kind,
              serverId: about.title.serverId,
              arrId: about.title.arrId,
              title: about.name,
            }
          : {}),
        steps: [],
        actions: [],
      })
    );
    this.queue.push(run.id);
    void this.pump();
    return run;
  }

  /**
   * An admin's answer, correction or follow-up; the run resumes where it
   * was, with everything found so far.
   */
  public async reply(id: number, text: string, user: User): Promise<AgentRun> {
    const problem = this.problem(user);
    if (problem) throw new Error(problem);
    const runs = getRepository(AgentRun);
    let run = await runs.findOne({ where: { id } });
    if (!run) throw new NoSuchRun('There is no such conversation.');
    const said = text.trim().slice(0, MAX_ASK);
    // Working or queued: read before its next step. Decided by in-memory
    // state, not the status read above, which may be stale if the run just
    // finished.
    if (this.current === id || this.queue.includes(id)) {
      const live = this.live.get(id) ?? { notes: [] };
      if (live.stopBy) throw new Error('It is stopping.');
      if (live.notes.length >= MAX_NOTES) {
        throw new Error('It has not read what was said yet; wait a moment.');
      }
      live.notes.push({ by: user.displayName, text: said });
      this.live.set(id, live);
      return run;
    }
    if (run.status === 'queued' || run.status === 'running') {
      // It finished since the read above: read it again.
      run = await runs.findOne({ where: { id } });
      if (!run) throw new NoSuchRun('There is no such conversation.');
      if (run.status === 'queued' || run.status === 'running') {
        throw new Error('It is busy; try again in a moment.');
      }
    }
    run.steps.push({
      at: new Date().toISOString(),
      kind: 'reply',
      text: `${user.displayName}: ${said}`,
    });
    // Replying instead of approving drops the proposal. An approval a failed
    // run never got to is dropped too: it was approved for then, not for
    // whenever the run is next replied to.
    const pending = proposalOf(run);
    const {
      proposal: _dropped,
      decision: undone,
      ...memory
    } = (run.memory ?? {}) as {
      proposal?: Proposal;
      decision?: Decision;
    };
    void _dropped;
    run.memory = memory;
    this.tellRun(
      run,
      `${user.displayName} (admin) says: ${said}${
        pending
          ? '\n(What you proposed was not approved and nothing of it was done; propose again if it is still wanted.)'
          : ''
      }${
        undone
          ? '\n(What an admin approved earlier was never done: you stopped before getting to it. Propose it again if it is still wanted.)'
          : ''
      }`
    );
    run.status = 'queued';
    run.question = null;
    run.error = null;
    // An admin's reply makes it their work again.
    if (run.purpose === 'retry') run.purpose = 'work';
    // The rest of the conversation acts as whoever is replying now.
    run.requestedById = user.id;
    run.requestedByName = run.requestedByName ?? user.displayName;
    await runs.save(run);
    this.queue.push(run.id);
    void this.pump();
    return run;
  }

  /**
   * Stops a queued or working run before its next step. What it started
   * carries on, and a later reply resumes it where it was.
   */
  public async stop(id: number, user: User): Promise<AgentRun> {
    const runs = getRepository(AgentRun);
    const found = await runs.findOne({ where: { id } });
    if (!found) throw new NoSuchRun('There is no such conversation.');
    if (this.current === id) {
      const live = this.live.get(id) ?? { notes: [] };
      live.stopBy = user.displayName;
      this.live.set(id, live);
      return found;
    }
    if (!this.queue.includes(id)) {
      throw new Error('It is not working on this one.');
    }
    // Dequeue first so it cannot start, keep anything said while it waited
    // for a later reply, then reread it, as nothing else writes it now.
    this.queue = this.queue.filter((queued) => queued !== id);
    const notes = this.live.get(id)?.notes ?? [];
    this.live.delete(id);
    if (notes.length) await this.deliverLate(id, notes, false);
    const run = await runs.findOneOrFail({ where: { id } });
    const { decision: undone, ...memory } = (run.memory ?? {}) as {
      decision?: Decision;
    };
    run.memory = memory;
    run.status = 'done';
    run.summary = `Stopped by ${user.displayName} before it started.${
      undone ? ` ${notDone(undone)}` : ''
    }`;
    run.finishedAt = new Date();
    run.steps.push({
      at: new Date().toISOString(),
      kind: 'say',
      text: run.summary,
    });
    await runs.save(run);
    return run;
  }

  /**
   * Adds what admins said too late for a finishing run to read. With
   * `resume`, a finished run goes on with it; one waiting on an admin keeps
   * its question or proposal and reads it when it resumes.
   */
  private async deliverLate(
    id: number,
    notes: { by: string; text: string }[],
    resume: boolean
  ): Promise<void> {
    const runs = getRepository(AgentRun);
    const run = await runs.findOne({ where: { id } });
    if (!run) return;
    const at = new Date().toISOString();
    for (const note of notes) {
      run.steps.push({ at, kind: 'reply', text: `${note.by}: ${note.text}` });
    }
    this.tellRun(
      run,
      notes.map((note) => `${note.by} (admin) says: ${note.text}`).join('\n')
    );
    if (resume && run.status !== 'waiting') {
      run.status = 'queued';
      run.error = null;
      if (run.purpose === 'retry') run.purpose = 'work';
    }
    await runs.save(run);
    if (resume && run.status === 'queued') this.queue.push(id);
  }

  /**
   * Approves a run's proposal: the run resumes, first carrying out the
   * changes, each rechecked against the current state. Only the proposal
   * shown, and only once.
   */
  public async approve(
    id: number,
    proposalId: string,
    user: User
  ): Promise<AgentRun> {
    return this.decide(id, proposalId, user, true);
  }

  /** Declines a run's proposal: nothing changes, and the run ends. */
  public async decline(
    id: number,
    proposalId: string,
    user: User
  ): Promise<AgentRun> {
    return this.decide(id, proposalId, user, false);
  }

  private deciding = new Set<number>();

  private async decide(
    id: number,
    proposalId: string,
    user: User,
    approved: boolean
  ): Promise<AgentRun> {
    if (!user.hasPermission(Permission.ADMIN)) {
      throw new Error('Only an admin can decide on these changes.');
    }
    if (approved) {
      const problem = this.problem(user);
      if (problem) throw new Error(problem);
    }
    if (this.deciding.has(id)) {
      throw new Error('This is being decided on already.');
    }
    this.deciding.add(id);
    try {
      const runs = getRepository(AgentRun);
      const run = await runs.findOne({ where: { id } });
      if (!run) throw new NoSuchRun('There is no such conversation.');
      const proposal = proposalOf(run);
      if (run.status !== 'waiting' || !proposal || proposal.id !== proposalId) {
        throw new Error(
          'These changes are no longer waiting; reload to see where it stands.'
        );
      }
      const headlines = proposal.changes.map((c) => c.headline).join('; ');
      const direct = directOf(run);
      const { proposal: _taken, ...memory } = run.memory as {
        proposal?: Proposal;
      };
      void _taken;
      run.question = null;
      run.error = null;
      run.steps.push({
        at: new Date().toISOString(),
        kind: 'reply',
        text: decisionText(user.displayName, approved, headlines),
      });
      if (approved) {
        const decision: Decision = {
          by: user.displayName,
          changes: proposal.changes,
        };
        run.memory = { ...memory, decision };
        run.status = 'queued';
        // It continues as the approving admin.
        run.requestedById = user.id;
        await runs.save(run);
        this.queue.push(run.id);
        void this.pump();
        return run;
      }
      run.memory = memory;
      run.conversation = [
        ...run.conversation,
        {
          role: 'user',
          text: `${user.displayName} (admin) declined: ${headlines}. None of it was done.`,
        },
      ];
      run.status = 'done';
      run.summary = `${user.displayName} declined: ${headlines}. Nothing was changed.`;
      run.finishedAt = new Date();
      // Proposed on someone's behalf: they hear it was declined.
      if (direct && this.reportSettled(run)) {
        await runs.save(run);
        await this.comment(
          run,
          `Admin agent: An admin declined this: ${headlines}. Nothing was changed.`
        );
        return run;
      }
      await runs.save(run);
      return run;
    } finally {
      this.deciding.delete(id);
    }
  }

  /** Carries out approved changes in order, returning what came of each. */
  private async carryOut(
    decision: Decision,
    state: AgentState
  ): Promise<string> {
    const lines: string[] = [];
    for (const change of decision.changes) {
      try {
        if (change.kind === 'replace' || change.kind === 'oversizeGrab') {
          // The grab records itself, like any download it starts.
          const said = await startApprovedGrab(
            state,
            change.params.grab,
            `AI agent, approved by ${decision.by}`
          );
          lines.push(`Done: ${change.headline}. ${said}`);
          continue;
        }
        if (change.kind === 'replaceSeason') {
          const outcome = await applySeasonChange(change);
          if (!outcome.ok) {
            lines.push(`Not done: ${change.headline}. ${outcome.message}`);
            continue;
          }
          state.act({
            at: new Date().toISOString(),
            type: 'change',
            change: change.kind,
            approvedBy: decision.by,
            title: state.run.title ?? change.headline,
            detail: `${change.headline} (approved by ${decision.by}): ${outcome.message}`,
          });
          lines.push(`Done: ${outcome.message}`);
          // The reporter hears when the season is back.
          const report = reportOf(state.run);
          if (report.issueId && change.title) {
            await this.follow({
              title: change.title,
              name: state.run.title ?? '',
              issueId: report.issueId,
              seasonNumber: Number(change.params.season),
              episodeIds: outcome.episodeIds,
            }).catch((e) =>
              logger.warn('Could not follow a replaced season', {
                label: LABEL,
                runId: state.run.id,
                errorMessage: e instanceof Error ? e.message : String(e),
              })
            );
          }
          continue;
        }
        const said = await applyChange(change);
        state.act({
          at: new Date().toISOString(),
          type: 'change',
          change: change.kind,
          approvedBy: decision.by,
          title: state.run.title ?? change.headline,
          detail: `${change.headline} (approved by ${decision.by}): ${said}`,
        });
        lines.push(`Done: ${change.headline}. ${said}`);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        logger.warn('Could not make an approved change', {
          label: LABEL,
          runId: state.run.id,
          change: change.kind,
          errorMessage: why,
        });
        lines.push(`Not done: ${change.headline}. ${why}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * When Backfill found nothing usable for a title, looks further if it was
   * requested, the agent hasn't tried it lately, and today's runs aren't
   * used up.
   */
  public async afterEmptySearch(row: BackfillSeries): Promise<AgentRun | null> {
    const settings = getSettings().backfill;
    if (!settings.agent.autoRun) return null;
    const user = await owner();
    if (this.problem(user)) return null;
    if (row.agentAutoRunAt) return null;
    const title: AgentTitle = {
      kind: row.kind,
      serverId: row.serverId,
      arrId: row.arrId,
    };
    if (!(await requestedSince([row])).has(row.id)) return null;
    const runs = getRepository(AgentRun);
    const lately = new Date(Date.now() - settings.researchAfterDays * DAY);
    const recent = await runs.count({
      where: [
        {
          ...sameTitle(title),
          createdAt: MoreThan(lately),
          purpose: In(COUNTED),
        },
        {
          ...sameTitle(title),
          status: In(UNFINISHED),
          purpose: 'work',
        },
      ],
    });
    if (recent) return null;
    if ((await this.runsToday()) >= settings.agent.maxAutoRunsPerDay) {
      return null;
    }
    const run = await runs.save(
      new AgentRun({
        trigger: 'auto',
        status: 'queued',
        ...title,
        title:
          row.kind === 'album' && row.artistName
            ? `${row.title} by ${row.artistName}`
            : row.title,
        steps: [],
        actions: [],
      })
    );
    this.queue.push(run.id);
    void this.pump();
    return run;
  }

  /**
   * Runs started in the last day without an admin asking (automatic or for
   * a report). Approval-only runs and followed seasons don't count.
   */
  private runsToday(): Promise<number> {
    return getRepository(AgentRun).count({
      where: {
        trigger: In(['auto', 'report']),
        purpose: In(COUNTED),
        createdAt: MoreThan(new Date(Date.now() - DAY)),
      },
    });
  }

  public isBusy(): boolean {
    return this.running || this.queue.length > 0;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const id = this.queue.shift();
    if (id === undefined) return;
    this.running = true;
    this.current = id;
    try {
      await this.execute(id);
    } catch (e) {
      logger.error('The admin agent failed', {
        label: LABEL,
        runId: id,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    } finally {
      // Deliver notes that arrived too late to read. It stays the current
      // run meanwhile so new notes also land here, then is released with
      // nothing in between.
      for (;;) {
        const live = this.live.get(id);
        if (!live?.notes.length) break;
        const notes = live.notes.splice(0);
        await this.deliverLate(id, notes, !live.stopBy).catch((e) =>
          logger.warn('Could not pass on what an admin said', {
            label: LABEL,
            runId: id,
            errorMessage: e instanceof Error ? e.message : String(e),
          })
        );
      }
      this.live.delete(id);
      this.current = undefined;
      this.running = false;
      void this.pump();
    }
  }

  /**
   * Adds a user message to a run. A run without a first turn yet (stopped
   * before it, a held report replied to, a change approved on someone's
   * behalf) gets its opening message first.
   */
  private tellRun(run: AgentRun, text: string): void {
    const opening = run.conversation.length
      ? ''
      : `${this.firstMessage(run)}\n\n`;
    run.conversation = [
      ...run.conversation,
      { role: 'user', text: `${opening}${text}` },
    ];
  }

  private firstMessage(run: AgentRun): string {
    if (run.trigger === 'ask' && run.arrId != null) {
      const ref = titleRef({
        kind: run.kind ?? 'series',
        serverId: run.serverId ?? 0,
        arrId: run.arrId,
      });
      return `An admin asked about ${run.title} (${ref}), from its page: ${run.ask}`;
    }
    if (run.trigger === 'ask') {
      return `An admin asked: ${run.ask}\n\nIf it is not in the library, you may request it with request_title, then say it will be searched once Sonarr, Radarr or Lidarr adds it.`;
    }
    const ref = titleRef({
      kind: run.kind ?? 'series',
      serverId: run.serverId ?? 0,
      arrId: run.arrId ?? 0,
    });
    if (run.trigger === 'report' && reportOf(run).replace) {
      const { seasonNumber } = reportOf(run);
      const what =
        seasonNumber !== undefined
          ? `season ${seasonNumber} of ${run.title}`
          : run.title;
      return `Someone reported that ${what} (${ref}) is bad and asked for it to be replaced. Sonarr's search found no other release it would take. Look further with search_releases and search_indexers. ${
        seasonNumber !== undefined
          ? 'For the whole season, use replace_season if Sonarr now offers something; a release found elsewhere is taken with grab and replace: true.'
          : 'A release found is taken with grab and replace: true.'
      } Either way an admin approves it first, and the old files go only after the new ones are in. If nothing usable exists, say so and what you tried.`;
    }
    if (run.trigger === 'report') {
      const { seasonNumber } = reportOf(run);
      // Not the reporter's name: they chose it, so the model must not read
      // it as anything. The page still shows who it was.
      return `Someone reported that ${run.title} (${ref}) is missing${
        seasonNumber !== undefined ? ` episodes in season ${seasonNumber}` : ''
      }. ${
        run.kind === 'movie' ? 'Radarr' : 'Sonarr'
      } searched again and found nothing usable, and neither did Backfill's search of Prowlarr. Find out what is missing and get it if you can.`;
    }
    return `Someone requested ${run.title} (${ref}). ${
      run.kind === 'album' ? 'Lidarr' : 'Sonarr or Radarr'
    } has not found it for a day or more, and Backfill's search of Prowlarr found nothing it could use on its own. Find out what is missing and get it if you can.`;
  }

  private async execute(id: number): Promise<void> {
    const runs = getRepository(AgentRun);
    const run = await runs.findOne({ where: { id } });
    if (!run || run.status !== 'queued') return;
    const settings = getSettings();
    const user =
      (run.requestedById
        ? await getRepository(User).findOne({
            where: { id: run.requestedById },
          })
        : null) ?? (await owner());
    run.status = 'running';
    run.startedAt = run.startedAt ?? new Date();
    await runs.save(run);
    const actionsBefore = run.actions.length;

    const step = (kind: AgentStep['kind'], text: string, tool?: string) => {
      run.steps.push({
        at: new Date().toISOString(),
        kind,
        text: text.slice(0, 2000),
        ...(tool ? { tool } : {}),
      });
      trimSteps(run);
    };

    let asked: string | null = null;
    const proposed: ProposedChange[] = [];
    let messages: ConverseMessage[] | null = null;
    let answerIssue = false;
    try {
      const problem = this.problem(user);
      if (problem || !user) {
        throw new Error(problem ?? 'There is no owner account.');
      }

      // Downloads count by start time across all conversations, so an old
      // one replied to today gets no fresh day's worth. Each go sets the
      // finish time, so any run that grabbed in the last day finished since.
      const dayAgo = Date.now() - DAY;
      const others = await runs.find({
        select: { id: true, actions: true },
        where: { finishedAt: MoreThan(new Date(dayAgo)) },
      });
      const grabsToday = grabsSince(
        [...others.filter((r) => r.id !== run.id), run],
        dayAgo
      );
      const remembered = (run.memory?.releases ?? {}) as Record<
        string,
        KnownRelease
      >;
      const state: AgentState = {
        run,
        user,
        releases: new Map(Object.entries(remembered)),
        files: new Map(),
        series: new Map(),
        movies: new Map(),
        grabsToday,
        bind: (title: TitleRef, name: string) => {
          if (run.arrId == null) {
            run.kind = title.kind;
            run.serverId = title.serverId;
            run.arrId = title.arrId;
            run.title = name;
          }
        },
        act: (action) => {
          run.actions.push(action);
          step('action', action.detail);
        },
        ask: (question) => {
          asked = question;
        },
        propose: (change) => {
          proposed.push(change);
        },
      };
      // Notes are kept per title for later conversations, once the title is
      // known: the title its call named, else the bound one.
      const unfiled: { title?: TitleRef; note: AgentNote }[] = [];
      const fileNotes = () => {
        const bound = boundTitle(run);
        const byTitle = new Map<
          string,
          { title: TitleRef; notes: AgentNote[] }
        >();
        for (let i = 0; i < unfiled.length; ) {
          const title = unfiled[i].title ?? bound;
          if (!title) {
            i++;
            continue;
          }
          const key = titleRef(title);
          const entry = byTitle.get(key) ?? { title, notes: [] };
          entry.notes.push(unfiled[i].note);
          byTitle.set(key, entry);
          unfiled.splice(i, 1);
        }
        for (const { title, notes } of byTitle.values()) {
          addNotes(title, notes).catch((e: unknown) =>
            logger.warn('Could not keep the admin agent’s notes', {
              label: LABEL,
              runId: run.id,
              errorMessage: e instanceof Error ? e.message : String(e),
            })
          );
        }
      };
      const keep = (messages: ConverseMessage[]) => {
        run.conversation = messages;
        run.memory = {
          ...run.memory,
          releases: Object.fromEntries(state.releases),
        };
      };

      const ai = settings.ai;
      const model = modelFor('aiAgent');
      // Recomputed each turn: an admin who replies mid-run is present from
      // then on.
      const toolsNow = () =>
        TOOLS.filter((tool) => !tool.askOnly || adminPresent(run)).map(
          ({ name, description, parameters }) => ({
            name,
            description,
            parameters,
          })
        );
      const standing = settings.backfill.agent.instructions.trim();
      const system = standing
        ? `${SYSTEM}\n\nStanding instructions from the admin, always to be followed:\n${standing}`
        : SYSTEM;
      messages = run.conversation.length
        ? compact(answerCalls(run.conversation as ConverseMessage[]))
        : [{ role: 'user', text: this.firstMessage(run) }];
      let answer = '';
      const decision = (run.memory as { decision?: Decision }).decision;
      // Proposed on someone's behalf without the model: once approved, the
      // change is made and that is all.
      const direct = directOf(run) && !!decision;
      if (decision) {
        // Removed first, so an approval runs once whatever happens.
        const { decision: _done, ...rest } = run.memory as {
          decision?: Decision;
        };
        void _done;
        run.memory = rest;
        await runs.save(run);
        const outcome = await this.carryOut(decision, state);
        messages.push({
          role: 'user',
          text: `${decision.by} (admin) approved. What came of it:\n${outcome}\nTell the admin in a line or two; carry on only with what is still left of their ask.`,
        });
        if (direct) {
          answer = `Approved by ${decision.by}. ${outcome}`;
        }
      }
      const maxSteps = settings.backfill.agent.maxSteps;
      // A go that runs out of steps continues on its own while making
      // progress: the first time always, then only if the previous go
      // started a download.
      const extraGoes = settings.backfill.agent.autoContinue;
      let goes = 0;
      let actionsAtGo = run.actions.length;
      let used = 0;
      let warned = false;
      // Who stopped it, if an admin did.
      let stoppedBy: string | undefined;
      // Searches across the whole conversation, to find what it never
      // looked for, and whether it was told so this time.
      const searched: MadeCall[] = [
        ...((run.memory as { searched?: MadeCall[] }).searched ?? []),
      ];
      let toldWhatsLeft = false;
      const broad =
        run.trigger === 'auto' ||
        (run.trigger === 'report' && !reportOf(run).replace) ||
        BROAD_ASK.test(run.ask ?? '');

      for (; !direct; ) {
        // An admin may stop it or say something mid-run: checked before every
        // step.
        const live = this.live.get(run.id);
        if (live?.stopBy) {
          stoppedBy = live.stopBy;
          break;
        }
        // What earlier conversations tried for the title, told once the title
        // is known.
        const told = (run.memory as { notesTold?: boolean }).notesTold;
        const title = boundTitle(run);
        if (!told && title) {
          run.memory = { ...run.memory, notesTold: true };
          const since = (run.startedAt ?? new Date()).getTime();
          const earlier = describeNotes(
            (await notesOf(title).catch(() => [])).filter(
              (note) => new Date(note.at).getTime() < since
            )
          );
          if (earlier) {
            // Set apart from the admin's words: it is Seerr's record.
            const told = `---\n${earlier}`;
            const last = messages[messages.length - 1];
            if (last?.role === 'user') {
              last.text = `${last.text}\n\n${told}`;
            } else {
              messages.push({ role: 'user', text: told });
            }
          }
        }
        if (live?.notes.length) {
          const notes = live.notes.splice(0);
          for (const note of notes) step('reply', `${note.by}: ${note.text}`);
          const said = notes
            .map(
              (note) => `${note.by} (admin) says, while you work: ${note.text}`
            )
            .join('\n');
          const last = messages[messages.length - 1];
          if (last?.role === 'user') {
            last.text = `${last.text}\n\n${said}`;
          } else {
            messages.push({ role: 'user', text: said });
          }
          await runs.save(run);
        }
        const turn = await this.turnOf(
          run.id,
          ai,
          {
            model,
            system,
            messages,
            tools: toolsNow(),
            maxTokens: TURN_TOKENS,
          },
          async (text) => {
            step('error', text);
            await runs.save(run);
          }
        );
        if (!turn) {
          stoppedBy = this.live.get(run.id)?.stopBy;
          break;
        }
        await countAnswer(model, turn);
        run.inputTokens += turn.inputTokens;
        run.outputTokens += turn.outputTokens;
        if (turn.text) step('say', turn.text);
        messages.push({
          role: 'assistant',
          text: turn.text,
          calls: turn.calls,
          raw: turn.raw,
        });
        // When it says it's done after searching for everything, it is told
        // once about missing episodes its searches never named.
        if (
          !turn.calls.length &&
          !warned &&
          broad &&
          searched.length &&
          !toldWhatsLeft
        ) {
          toldWhatsLeft = true;
          const left = await notLookedFor(run, searched).catch(() => []);
          if (left.length) {
            const listed = left
              .slice(0, 40)
              .map(
                (ep) =>
                  `${episodeLabel(ep.seasonNumber, ep.episodeNumber)} "${ep.title ?? ''}"`
              )
              .join(', ');
            step(
              'say',
              `${left.length} missing episode${left.length === 1 ? ' was' : 's were'} never looked for; looking now.`
            );
            messages.push({
              role: 'user',
              text: `Not yet: ${left.length} missing episode${left.length === 1 ? ' was' : 's were'} never searched for: ${listed}${
                left.length > 40 ? ` and ${left.length - 40} more` : ''
              }. Search for each, one episode a search, by its number and by its title (releases may number them differently; a special by the show's name and its title), and open any season pack with release_files. Then say where things stand.`,
            });
            continue;
          }
        }
        if (!turn.calls.length || warned) {
          // Told to stop, it may still call tools: none run, but each gets
          // an answer, or the conversation could not continue.
          if (turn.calls.length) {
            messages.push({
              role: 'tool',
              results: turn.calls.map((call) => ({
                id: call.id,
                content: PAST_LIMIT,
                isError: true,
              })),
            });
          }
          answer = turn.text;
          break;
        }
        // Results are added as they arrive, so a partial stop keeps them.
        const results: ToolResult[] = [];
        messages.push({ role: 'tool', results });
        // Consecutive read-only calls run together (searches can take
        // minutes); anything that changes something runs alone, in order.
        const batches: (typeof turn.calls)[] = [];
        const skipped = turn.calls.slice(MAX_CALLS_PER_TURN);
        for (const call of turn.calls.slice(0, MAX_CALLS_PER_TURN)) {
          const last = batches[batches.length - 1];
          if (last && readOnly(call.name) && readOnly(last[0].name)) {
            last.push(call);
          } else {
            batches.push([call]);
          }
        }
        for (const [at, batch] of batches.entries()) {
          const stopping = this.live.get(run.id)?.stopBy;
          if (stopping) {
            for (const call of batches.slice(at).flat()) {
              results.push({
                id: call.id,
                content: `Not run: ${stopping} stopped it.`,
                isError: true,
              });
            }
            break;
          }
          for (const call of batch) {
            if (
              call.name === 'search_releases' ||
              call.name === 'search_indexers'
            ) {
              searched.push({ name: call.name, input: call.input });
            }
          }
          run.memory = { ...run.memory, searched: searched.slice(-500) };
          const calls = batch.map((call) => {
            step('tool', `${call.name}(${describe(call.input)})`, call.name);
            return { call, at: run.steps[run.steps.length - 1] };
          });
          await runs.save(run);
          let saving: Promise<unknown> = Promise.resolve();
          const answers = await Promise.all(
            calls.map(async ({ call, at }) => {
              const result = await runTool(state, call.name, call.input);
              const note = noteOfCall(
                call.name,
                call.input,
                result,
                state.releases.get(String(call.input.release ?? ''))?.title
              );
              if (note) {
                let title: TitleRef | undefined;
                try {
                  title = readTitleRef(call.input.title);
                } catch {
                  title = undefined;
                }
                unfiled.push({ title, note });
              }
              // Insert the result right after its call step.
              const answer: AgentStep = {
                at: new Date().toISOString(),
                kind: result.isError ? 'error' : 'result',
                text: result.text.slice(0, 2000),
                tool: call.name,
              };
              const after = run.steps.findIndex(
                (s) =>
                  s === at ||
                  (s.kind === 'tool' && s.at === at.at && s.text === at.text)
              );
              run.steps.splice(
                after < 0 ? run.steps.length : after + 1,
                0,
                answer
              );
              trimSteps(run);
              if (calls.length > 1) {
                saving = saving.then(() => runs.save(run)).catch(() => null);
              }
              return result;
            })
          );
          await saving;
          answers.forEach((result, i) =>
            results.push({
              id: calls[i].call.id,
              content: result.text,
              isError: result.isError,
            })
          );
          fileNotes();
        }
        for (const call of skipped) {
          results.push({
            id: call.id,
            content: `Not run: at most ${MAX_CALLS_PER_TURN} tools at once, to spare the indexers. Ask for it again.`,
            isError: true,
          });
        }
        used += 1;
        keep(messages);
        await runs.save(run);
        if (asked || proposed.length) break;
        if (used >= maxSteps) {
          const progressed = run.actions.length > actionsAtGo;
          if (goes < extraGoes && (goes === 0 || progressed)) {
            goes += 1;
            used = 0;
            actionsAtGo = run.actions.length;
            step(
              'say',
              `Used its ${maxSteps} steps; carrying on by itself (${goes} of ${extraGoes}).`
            );
            messages.push({
              role: 'user',
              text: `That was ${maxSteps} steps. Carry on with what is left, without redoing what you already did. You have another ${maxSteps}.`,
            });
            continue;
          }
          warned = true;
          messages.push({
            role: 'user',
            text: `That is the limit of ${maxSteps} steps for one go. Do not call any more tools; say where things stand now, and what you would do next. The admin can tell you to carry on.`,
          });
        }
      }

      keep(messages);
      fileNotes();
      if (proposed.length) {
        const proposal: Proposal = {
          id: randomUUID(),
          at: new Date().toISOString(),
          changes: proposed,
        };
        run.memory = { ...run.memory, proposal };
        run.status = 'waiting';
        const headlines = proposed.map((c) => c.headline).join('; ');
        run.question = asked
          ? `${asked}\n\nWaiting for approval: ${headlines}.`
          : `Waiting for approval: ${headlines}.`;
        step('propose', headlines);
      } else if (asked) {
        run.status = 'waiting';
        run.question = asked;
        step('ask', asked);
      } else if (stoppedBy) {
        const started = run.actions.length - actionsBefore;
        run.summary = `Stopped by ${stoppedBy}.${
          started
            ? ` It had started ${started} download${started === 1 ? '' : 's'}, which carry on.`
            : ''
        } Reply to have it carry on from here.`;
        step('say', run.summary);
        run.status = 'done';
      } else {
        run.summary = answer || 'Done.';
        if (warned) {
          const note = goes
            ? `It stopped after ${goes + 1} goes of ${maxSteps} steps${
                goes < extraGoes ? ', as the last one started nothing' : ''
              }. Reply to let it carry on.`
            : `It stopped at its limit of ${maxSteps} steps. Reply to let it carry on.`;
          step('say', note);
          run.summary = `${run.summary}\n\n${note}`;
        }
        run.status = 'done';
      }
    } catch (e) {
      noteFailure(e);
      run.status = 'failed';
      run.error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      if (isOutage(e)) {
        // Resumes on its own once the service answers.
        const since = lostSince(run) ?? new Date().toISOString();
        run.memory = { ...withoutOutage(run), outage: { since } };
        run.error = `${run.error} It carries on by itself once the AI service answers again, for up to a day; or reply to have it try now.`;
      } else {
        run.memory = withoutOutage(run);
      }
      step('error', run.error);
      // Drop an approval it never got to, rather than carry it out on the
      // next reply, and tell the admin.
      const { decision: undone, ...rest } = (run.memory ?? {}) as {
        decision?: Decision;
      };
      if (undone) {
        run.memory = rest;
        const note = notDone(undone).slice(0, 500);
        step('error', note);
        run.error = `${run.error}\n\n${note}`;
      }
    } finally {
      // Keep it as far as it got, with every call answered, so it can be
      // replied to.
      if (messages) run.conversation = answerCalls(messages);
      run.finishedAt = new Date();
      answerIssue = this.reportSettled(run);
      await runs.save(run);
    }
    await this.remember(run, run.actions.slice(actionsBefore));
    await this.tell(run, run.actions.slice(actionsBefore)).catch(
      () => undefined
    );
    if (answerIssue) await this.answerReport(run);
    // Settle downloads it was looking again for, and hand it any that
    // failed while it worked.
    await this.followFailures(run.id);
  }

  /**
   * Notes a failed download it started on its title. Best effort: nothing
   * depends on it succeeding.
   */
  private async noteFailed(job: BackfillJob): Promise<void> {
    try {
      const row = await getRepository(BackfillSeries).findOne({
        select: { id: true, kind: true, serverId: true, arrId: true },
        where: { id: job.seriesId },
      });
      if (!row) return;
      await addNotes(row, [
        {
          at: new Date().toISOString(),
          kind: 'failed',
          what: job.title,
          ...(job.error ? { why: job.error } : {}),
        },
      ]);
    } catch (e) {
      logger.warn('Could not keep the admin agent’s notes', {
        label: LABEL,
        jobId: job.id,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * A download it started failed for its release (Backfill found no good
   * pack to replace it). It looks again in the same conversation, with the
   * same permissions, unless replacements for those episodes failed
   * MAX_FAILED_REPLACEMENTS times today or today's downloads are used up.
   * Null when it can't look: the conversation is gone or it can't work.
   */
  public async afterFailedDownload(job: BackfillJob): Promise<AgentHandBack> {
    const run = await this.runOf(job);
    if (run) await this.noteFailed(job);
    if (!run || this.problem(await owner())) return null;
    const wanted = new Set(jobEpisodes(job));
    const failed = (
      await getRepository(BackfillJob).find({
        select: {
          id: true,
          files: true,
          agentRunId: true,
          approvedByName: true,
        },
        where: {
          seriesId: job.seriesId,
          status: 'failed',
          finishedAt: MoreThan(new Date(Date.now() - DAY)),
        },
      })
    ).filter(
      (other) =>
        startedByAgent(other) && jobEpisodes(other).some((id) => wanted.has(id))
    );
    // The first was the original download; the rest were replacements.
    const replacements = failed.length - 1;
    if (replacements >= MAX_FAILED_REPLACEMENTS) {
      return {
        stopped: 'gaveUp',
        why: `${replacements} replacements for these episodes failed today, so the admin agent stopped looking`,
      };
    }
    const most = getSettings().backfill.agent.maxGrabsPerDay;
    if ((await this.grabsToday()) >= most) {
      return {
        stopped: 'limit',
        why: `The admin agent's ${most} downloads for today are used up, so it did not look for another`,
      };
    }
    return { look: () => this.followFailures(run.id) };
  }

  /** The conversation that started a download. */
  private async runOf(job: BackfillJob): Promise<AgentRun | null> {
    const runs = getRepository(AgentRun);
    if (job.agentRunId) {
      return runs.findOne({ where: { id: job.agentRunId } });
    }
    // Jobs without agentRunId: found through recent runs' grabs.
    const recent = await runs.find({
      select: { id: true, actions: true },
      where: { createdAt: MoreThan(new Date(Date.now() - 30 * DAY)) },
      order: { id: 'DESC' },
    });
    const id = recent.find((run) =>
      run.actions.some(
        (a) => a.type === 'grab' && !a.extended && a.jobId === job.id
      )
    )?.id;
    return id ? runs.findOne({ where: { id } }) : null;
  }

  /** Downloads started in the last day, by any conversation. */
  private async grabsToday(): Promise<number> {
    const dayAgo = Date.now() - DAY;
    const runs = await getRepository(AgentRun).find({
      select: { id: true, actions: true },
      where: { finishedAt: MoreThan(new Date(dayAgo)) },
    });
    return grabsSince(runs, dayAgo);
  }

  /** Serializes follow-ups, so concurrent failures tell a run once. */
  private following: Promise<void> = Promise.resolve();

  /**
   * After a go, or when a download it started fails: settles what it looked
   * again for (replaced, or nothing else found, which admins hear), and
   * starts a go for failed downloads it hasn't been told of. Only once a go
   * is over; while it works or waits on an admin, they wait.
   */
  public followFailures(runId: number): Promise<void> {
    const next = this.following.then(() =>
      this.followFailuresNow(runId).catch((e) => {
        logger.warn('Could not hand failed downloads back to the admin agent', {
          label: LABEL,
          runId,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
      })
    );
    this.following = next;
    return next;
  }

  private async followFailuresNow(runId: number): Promise<void> {
    const runs = getRepository(AgentRun);
    const jobs = getRepository(BackfillJob);
    const run = await runs.findOne({ where: { id: runId } });
    // While it works or waits on an admin, leave the conversation alone.
    if (!run || !FINISHED.includes(run.status)) return;
    const row = run.kind
      ? await getRepository(BackfillSeries).findOne({
          where: {
            kind: run.kind,
            serverId: run.serverId ?? 0,
            arrId: run.arrId ?? 0,
          },
        })
      : null;
    const notice = (
      job: BackfillJob,
      kind: 'replaced' | 'failed',
      why?: string
    ) =>
      backfillNotices.add({
        kind,
        seriesId: job.seriesId,
        title: row?.title ?? run.title ?? job.title,
        poster: row?.poster,
        what: jobWhat(job, run.kind),
        detail: `${(job.error ?? 'The download failed').replace(/\.$/, '')}${
          why ? `; ${why}` : ''
        }`,
        url: `/backfill/jobs/${job.id}`,
      });

    // What it was told of was either replaced since or, with the go over,
    // nothing else was found.
    const told = lookingForOf(run);
    for (const job of told.length
      ? await jobs.find({ where: { id: In(told) } })
      : []) {
      if (job.followUp === 'replaced') {
        notice(job, 'replaced');
      } else if (job.followUp === 'agent') {
        const settled = await jobs.update(
          { id: job.id, followUp: 'agent' },
          { followUp: 'none' }
        );
        if (settled.affected) {
          notice(job, 'failed', 'the admin agent found nothing else');
        }
      }
    }

    // Failed downloads it started and hasn't been told of yet.
    const started = run.actions
      .filter((a) => a.type === 'grab' && !a.extended && a.jobId)
      .map((a) => a.jobId!);
    const fresh = started.length
      ? (
          await jobs.find({
            where: { id: In(started), status: 'failed', followUp: 'agent' },
            order: { id: 'ASC' },
          })
        ).filter((job) => !told.includes(job.id))
      : [];
    const problem = fresh.length ? this.problem(await owner()) : null;
    if (problem) {
      for (const job of fresh) {
        await jobs.update(
          { id: job.id, followUp: 'agent' },
          { followUp: 'none' }
        );
        notice(
          job,
          'failed',
          `the admin agent could not look again: ${problem}`
        );
      }
    }
    const telling = problem ? [] : fresh;
    if (!telling.length) {
      if (told.length) {
        await runs.update(run.id, {
          memory: { ...run.memory, lookingFor: [] },
        });
      }
      return;
    }

    const text = this.lookAgainText(telling, run.kind);
    run.steps.push({ at: new Date().toISOString(), kind: 'followUp', text });
    trimSteps(run);
    this.tellRun(run, text);
    run.memory = {
      ...run.memory,
      lookingFor: telling.map((job) => job.id),
    };
    // Another go of the same run, not a new one: no report waits on it.
    if (run.purpose === 'work') run.purpose = 'retry';
    run.status = 'queued';
    run.question = null;
    run.error = null;
    await runs.save(run);
    this.queue.push(run.id);
    void this.pump();
  }

  /** The message telling it downloads it started failed. */
  private lookAgainText(failed: BackfillJob[], kind: AgentRun['kind']) {
    const what = [...new Set(failed.map((job) => jobWhat(job, kind)))].join(
      ', '
    );
    const releases = failed.map((job) => `"${job.title}"`).join(', ');
    const groups = [
      ...new Set(
        failed
          .map(
            (job) =>
              job.files.find((f) => f.releaseGroup)?.releaseGroup ??
              releaseGroup(job.title)
          )
          .filter((group): group is string => !!group)
      ),
    ].join(', ');
    return `${failed
      .map(
        (job) =>
          `Download #${job.id} failed (${(job.error ?? 'it failed').replace(/\.$/, '')}).`
      )
      .join(
        ' '
      )} Find another release for ${what}; do not pick the same release (${releases})${
      groups ? ` or group (${groups})` : ''
    } again.`;
  }

  /**
   * Whether this go answers the reported issue: the first go of the
   * report's conversation to finish done (waiting or failed ones are for
   * admins first). Marks the report answered, so an admin's later
   * follow-ups stay off the issue.
   */
  private reportSettled(run: AgentRun): boolean {
    const report = reportOf(run);
    if (
      run.trigger !== 'report' ||
      !report.issueId ||
      report.answered ||
      run.status !== 'done'
    ) {
      return false;
    }
    run.memory = { ...run.memory, report: { ...report, answered: true } };
    return true;
  }

  /**
   * After each go, records what the agent did in the title's history, and
   * marks the title when the run was its own, since it runs on its own only
   * once per title.
   */
  private async remember(
    run: AgentRun,
    actions: AgentRun['actions']
  ): Promise<void> {
    if (!run.kind || run.arrId == null) return;
    // A go waiting on an admin is noted only for its actions; the rest when
    // the conversation is over.
    const over = run.status === 'done' || run.status === 'failed';
    if (!over && !actions.length) return;
    // A change proposed on someone's behalf isn't the agent acting on its
    // own.
    const own =
      run.trigger === 'auto' ||
      (run.trigger === 'report' &&
        !reportOf(run).byAdmin &&
        !(run.memory as DirectMemory).direct);
    try {
      const series = getRepository(BackfillSeries);
      const where = {
        kind: run.kind,
        serverId: run.serverId ?? 0,
        arrId: run.arrId,
      };
      const row = await series.findOne({ where });
      if (own && over && row && !row.agentAutoRunAt) {
        await series.update(row.id, { agentAutoRunAt: new Date() });
      }
      if (!row?.tmdbId) return;
      const count = (type: string) =>
        actions.filter((a) => a.type === type).length;
      const did = [
        [count('grab'), 'started a download', 'started {n} downloads'],
        [count('stop'), 'stopped a download', 'stopped {n} downloads'],
        [count('relink'), 'relinked a file', 'relinked {n} files'],
        [count('request'), 'requested it', 'requested {n} titles'],
        [
          count('change'),
          'made an approved change',
          'made {n} approved changes',
        ],
      ]
        .filter(([n]) => n)
        .map(([n, one, many]) =>
          n === 1 ? String(one) : String(many).replace('{n}', String(n))
        );
      const who = own
        ? 'On its own (it does that once per title)'
        : `Asked by ${run.requestedByName ?? 'an admin'}${
            run.trigger === 'report' ? ', reporting it missing' : ''
          }`;
      const outcome =
        run.status === 'failed'
          ? `it could not finish: ${run.error ?? 'an error'}`
          : did.length
            ? `${did.join(', ')}${over ? '' : ', and is waiting on an admin'}`
            : run.actions.length > actions.length
              ? 'it found nothing more it could use'
              : 'it found nothing it could use';
      await recordMediaEvent({
        tmdbId: row.tmdbId,
        mediaType: run.kind === 'movie' ? MediaType.MOVIE : MediaType.TV,
        type: MediaEventType.AGENT,
        userId: own ? null : run.requestedById,
        detail: `${who}: ${outcome}.`.slice(0, 250),
      });
    } catch (e) {
      logger.warn('Could not note what the agent did for a title', {
        label: LABEL,
        runId: run.id,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** Posts a reported title's outcome on its issue. */
  private async answerReport(run: AgentRun): Promise<void> {
    await this.comment(
      run,
      `Admin agent: ${(run.summary ?? 'Done.').slice(0, 2000)}`
    );
  }

  /** Comments on the run's reported issue, if any. */
  private async comment(run: AgentRun, message: string): Promise<void> {
    const { issueId } = reportOf(run);
    if (!issueId) return;
    try {
      const issue = await getRepository(Issue).findOne({
        where: { id: issueId },
      });
      const author = await owner();
      if (!issue || !author) return;
      await getRepository(IssueComment).save(
        new IssueComment({ issue, user: author, message })
      );
    } catch (e) {
      logger.warn('Could not answer a report with what the agent did', {
        label: LABEL,
        runId: run.id,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Sends a question to admins at once. What it did is batched with
   * Backfill's other news, so a busy run is one notification among them.
   */
  private async tell(run: AgentRun, actions: AgentRun['actions']) {
    if (!actions.length && run.status !== 'waiting') return;
    const name = run.title ?? 'Admin agent';
    if (run.status === 'waiting') {
      const proposal = proposalOf(run);
      notificationManager.sendNotification(Notification.BACKFILL, {
        ...adminAgentEvent(),
        notifyAdmin: true,
        notifySystem: true,
        subject: proposal
          ? `${name}: the admin agent needs your approval`
          : `${name}: the admin agent has a question`,
        message: run.question ?? '',
        // Links to the proposal, or to the question's answer box.
        actionUrl: `/backfill/agent/${run.id}${
          proposal ? '#review' : '#answer'
        }`,
        actionUrlTitle: proposal ? 'Review' : 'Answer',
      });
      // What it did before asking is reported like any other go.
      if (!actions.length) return;
    }
    const count = (type: string) =>
      actions.filter((a) => a.type === type).length;
    const did = [
      [count('grab'), 'download started', 'downloads started'],
      [count('stop'), 'download stopped', 'downloads stopped'],
      [count('relink'), 'file relinked', 'files relinked'],
      [count('request'), 'title requested', 'titles requested'],
      [count('change'), 'approved change made', 'approved changes made'],
    ]
      .filter(([n]) => n)
      .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`)
      .join(', ');
    const row =
      run.kind && run.arrId != null
        ? await getRepository(BackfillSeries)
            .findOne({
              where: {
                kind: run.kind,
                serverId: run.serverId ?? 0,
                arrId: run.arrId,
              },
            })
            .catch(() => null)
        : null;
    backfillNotices.add({
      kind: 'agent',
      // Grouped with the title's Backfill news when it has a row there.
      seriesId: row?.id ?? -run.id,
      title: name,
      poster: row?.poster,
      what: did || `${actions.length} changes`,
      url: `/backfill/agent/${run.id}`,
    });
  }
}

const agent = new Agent();

// Hears of every failed download it started, from load.
backfill.onAgentDownloadFailed = (job) => agent.afterFailedDownload(job);

export default agent;
