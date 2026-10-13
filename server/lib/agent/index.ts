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
import { applyChange } from '@server/lib/agent/changes';
import type {
  AgentState,
  KnownRelease,
  TitleRef,
} from '@server/lib/agent/tools';
import {
  TOOLS,
  adminPresent,
  runTool,
  startApprovedGrab,
  titleRef,
} from '@server/lib/agent/tools';
import { aiFeatureOn, modelFor } from '@server/lib/ai';
import { countAnswer, noteFailure } from '@server/lib/ai/credit';
import type { ConverseMessage, ToolResult } from '@server/lib/ai/providers';
import { converse } from '@server/lib/ai/providers';
import backfill, { requestedSince } from '@server/lib/backfill/engine';
import backfillNotices from '@server/lib/backfill/notices';
import { recordMediaEvent } from '@server/lib/mediaHistory';
import notificationManager, { Notification } from '@server/lib/notifications';
import { adminAgentEvent } from '@server/lib/notifications/eventTitles';
import { owner } from '@server/lib/owner';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isAxiosError } from 'axios';
import { randomUUID } from 'node:crypto';
import type { FindOptionsWhere } from 'typeorm';
import { In, LessThan, MoreThan } from 'typeorm';

/*
 * The admin agent: a model with the tools an admin would use to get a
 * stuck title downloaded. It starts on its own for a requested title that
 * Backfill's search found nothing usable for, and runs when an admin asks
 * it something. One run at a time; each is kept with every step it took,
 * and any download it starts is told to admins.
 *
 * It decides what to try. What it may change is decided by the tools: on
 * its own, only missing episodes, within a size and a daily limit, in
 * English or the title's own language. Anything more an admin asks for
 * (replacing a file, blocking a release group, deleting files, marking a
 * download failed, changing a profile) it only proposes: the run waits,
 * and nothing happens until an admin approves.
 */

const LABEL = 'Agent';
/** Tools run in one go at most; more would hammer the indexers. */
const MAX_CALLS_PER_TURN = 12;
const readOnly = (name: string) =>
  !!TOOLS.find((tool) => tool.name === name)?.readOnly;
const DAY = 24 * 60 * 60 * 1000;
const MAX_ASK = 1000;
const MAX_STEPS_KEPT = 400;
/** How often old conversations are cleared out. */
const PURGE_EVERY_MS = 6 * 60 * 60 * 1000;
const FINISHED: AgentRun['status'][] = ['done', 'failed'];
/** How often a held report is checked on. */
const HOLD_CHECK_MS = 60 * 1000;
/** A report is held no longer than this for searches still going. */
const HOLD_LONGEST_MS = 6 * 60 * 60 * 1000;
const UNFINISHED: AgentRun['status'][] = [
  'held',
  'queued',
  'running',
  'waiting',
];
const SEARCH_COMMANDS = new Set([
  'EpisodeSearch',
  'SeasonSearch',
  'SeriesSearch',
  'MissingEpisodeSearch',
  'MoviesSearch',
]);

/** An admin's answer to a proposal, carried out when the run goes on. */
interface Decision {
  by: string;
  changes: ProposedChange[];
}

export const proposalOf = (run: AgentRun): Proposal | undefined =>
  (run.memory as { proposal?: Proposal } | null)?.proposal;

/** Where a report's run was asked from, kept with it. */
interface ReportMemory {
  issueId?: number;
  seasonNumber?: number;
  /** Reported by an admin: their ask, not the agent starting on its own. */
  byAdmin?: boolean;
  /**
   * The issue has had its answer: an admin's follow-ups after it stay
   * between them and the agent.
   */
  answered?: boolean;
}

/** The runs among these with a Backfill download they started still going. */
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
 * Deletes finished conversations matching `where`, leaving any whose
 * downloads are still going: a conversation is not over until they have
 * imported or failed.
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
  return result.affected ?? ids.length;
};

/** Whether it has already looked for this title on its own. */
const triedOn = async (title: {
  kind: 'series' | 'movie';
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
/** Room for its thinking out loud and a tool call or two. */
const TURN_TOKENS = 1500;

const SYSTEM = `You are the admin agent of a home media server run with Seerr, Sonarr, Radarr, Prowlarr and Backfill. You work like a careful admin by hand: get missing episodes and movies downloaded when the automatic searches could not. An admin talks with you in a chat; do what they ask, including extra checks or changes of plan, and keep to it for the rest of the conversation.

How to work:
1. Find the title (find_title) and read what it lacks (title_status).
2. Search two ways. search_releases is Sonarr's or Radarr's own search; the reasons they turned results down show problems you can work around: a wrong year or odd name, the collection's own episode numbering, a size limit, a quality the profile does not want. search_indexers searches Prowlarr directly with any words: try other names, the year, "complete", "collection", a season, the original title. Searches take a while, so ask for the ones you want together in one turn: they run at the same time. For anime, Sonarr's search is slow and goes episode by episode; search_indexers with the English and the original (romaji) names is usually quicker, and fansub releases often number episodes across all seasons.
3. Steps are limited, so do not spend them on what you already know. A release whose name plainly says it is one missing episode, with no other language in its name, needs neither release_files nor check_language: grab it. Grab several in the same turn. When the admin tells you to start what you found, grab it at once, without checking again what you checked earlier in this conversation. Before you grab a release with several files, or one whose name does not plainly say which episode it is, open it with release_files. Map each file to an episode by its number AND its title. Collections often number files in their own order (shorts or specials first, or one numbering across seasons): compare each file's title with the episode titles from title_status, and never trust the numbers alone.
4. Be certain before you grab. Check the language with check_language when there is any question. Grab only files for missing episodes. One file per episode is preferred: take a release whose files each hold several episodes (S06E01-02, "Title A + Title B") only when no release has those episodes one per file, and then give each such file every episode it holds (episodes: [1, 2]), so Sonarr names it S06E01-E02. Weigh it in this order: the right content; English or the title's original language; covering as much as possible; quality; size. When nothing meets the quality profile, a lower quality is fine as a stopgap, since Sonarr and Radarr keep looking for upgrades. Prefer a well-seeded torrent or usenet.
5. Turn down dubs in other languages (TRUEFRENCH, iTALiAN, GERMAN and so on, unless that is the original language), fakes (sizes far too small, torrents of archives or executables only), samples, and other shows. A Usenet post packed in archives, or with scrambled file names (only its PAR2 repair files named), is normal but cannot be opened: when its name is exactly one missing episode, or the movie, grab it whole (whole: true); a season pack like that cannot be used.
6. If the admin says something you started is wrong, stop it with stop_download and fix it. A file already imported that holds several episodes but is linked to only one (title_status shows the others missing, the file's name or length says it holds them) is fixed with relink_file, when an admin is in the conversation; nothing is downloaded. If nothing usable exists, say so and what you tried. Only ask the admin (ask_admin) when you truly cannot decide yourself.
7. When the admin asks you to change what is already there, propose it; the admin approves or declines, and nothing happens before that. A bad or wrong file: find a good release and grab it with replace: true (the old file goes only once the new one has imported), or search_upgrade to let Radarr or Sonarr find something better by its profile. A release group they do not want: propose_change blockGroup. A download that is wrong or broken: propose_change markFailed. Files to remove: propose_change deleteFiles. Another quality profile: propose_change changeProfile. Propose only what was asked for, then stop and wait; the next message says what was decided and what came of it.

Reply in short plain text, no headings or markdown: what was missing, what you found, what you started downloading (with its Backfill job number), and what is still missing and why.`;

/** Above this, the oldest tool results are cut short to keep costs down. */
const MAX_CONVERSATION_CHARS = 120_000;

/**
 * A long conversation is resent on every turn. Past this size, the oldest
 * tool results (searches and file lists it has long acted on) are cut to
 * their first line; everything said, and each call and its answer's place,
 * stays.
 */
export const compact = (messages: ConverseMessage[]): ConverseMessage[] => {
  const size = () =>
    messages.reduce(
      (n, m) =>
        n +
        (m.role === 'tool'
          ? m.results.reduce((k, r) => k + r.content.length, 0)
          : m.text.length),
      0
    );
  for (const message of messages) {
    if (size() <= MAX_CONVERSATION_CHARS) break;
    if (message.role !== 'tool') continue;
    message.results = message.results.map((result) =>
      result.content.length > 200
        ? {
            ...result,
            content: `${result.content.split('\n')[0].slice(0, 200)} … (shortened; run it again if needed)`,
          }
        : result
    );
  }
  return messages;
};

/** Calls it asked for after it was told it had no steps left. */
const PAST_LIMIT =
  'Not run: that was past the step limit for this go. Ask for it again if it is still wanted.';

/** Calls whose answer never came back, so it is not known what they did. */
const NO_ANSWER =
  'No answer: it stopped on an error before this answer came back, so it may or may not have been done. Look at where things stand before doing it again.';

/**
 * Every tool call answered in the message after it. Both APIs refuse a
 * conversation with a call left unanswered, so one saved that way (it
 * stopped on an error between a call and its answer, or was saved so by an
 * older version) could never be replied to; each such call is answered as
 * having no answer.
 */
export const answerCalls = (messages: ConverseMessage[]): ConverseMessage[] => {
  const out: ConverseMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    out.push(message);
    if (message.role !== 'assistant' || !message.calls?.length) continue;
    const next = messages[i + 1];
    const results = next?.role === 'tool' ? [...next.results] : [];
    const answered = new Set(results.map((result) => result.id));
    const missing = message.calls.filter((call) => !answered.has(call.id));
    if (!missing.length) continue;
    results.push(
      ...missing.map((call) => ({
        id: call.id,
        content: NO_ANSWER,
        isError: true,
      }))
    );
    out.push({ role: 'tool', results });
    // Its answers so far are in the one just added.
    if (next?.role === 'tool') i += 1;
  }
  return out;
};

const describe = (input: Record<string, unknown>) =>
  Object.entries(input)
    .map(([key, value]) =>
      key === 'files' && Array.isArray(value)
        ? `files=${value.length}`
        : `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`
    )
    .join(', ')
    .slice(0, 300);

const sameTitle = (row: BackfillSeries) => ({
  kind: row.kind,
  serverId: row.serverId,
  arrId: row.arrId,
});

class Agent {
  private queue: number[] = [];
  private running = false;
  private started = false;
  private purgeTimer?: NodeJS.Timeout;
  private holdTimer?: NodeJS.Timeout;
  private checkingHeld = false;

  /** Picks up after a restart, and hears of Backfill's empty searches. */
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
    this.holdTimer = setInterval(() => void this.checkHeld(), HOLD_CHECK_MS);
    this.holdTimer.unref();
  }

  /**
   * Someone reported a title missing, and Sonarr's or Radarr's search and
   * Backfill's have been started for it. The agent looks further once they
   * are over, if they found nothing: held until then. Only when it may run
   * on its own, and not while it is already on the title.
   */
  public async afterReport(report: {
    kind: 'series' | 'movie';
    serverId: number;
    arrId: number;
    title: string;
    reporter: User;
    issueId?: number;
    seasonNumber?: number;
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
    if (await runs.count({ where: { ...title, status: In(UNFINISHED) } })) {
      return null;
    }
    // An admin reporting it is asking; anyone else's report is the agent
    // starting on its own, which it does once per title.
    const byAdmin = report.reporter.hasPermission(Permission.ADMIN);
    if (!byAdmin && (await triedOn(title))) return null;
    const today = await runs.count({
      where: {
        trigger: In(['auto', 'report']),
        createdAt: MoreThan(new Date(Date.now() - DAY)),
      },
    });
    if (today >= settings.agent.maxAutoRunsPerDay) return null;
    const run = await runs.save(
      new AgentRun({
        trigger: 'report',
        status: 'held',
        ...title,
        title: report.title,
        ask: `Reported missing${
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
          },
        },
        steps: [],
        actions: [],
      })
    );
    return run;
  }

  /** Looks at every held report; one at a time. */
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
        // Only while it is still held: an admin may have replied to it
        // while it was being checked on, and their reply stands.
        const held = { id: run.id, status: 'held' as const };
        if ('notNeeded' in verdict) {
          await runs.update(held, {
            status: 'done',
            summary: verdict.notNeeded,
            finishedAt: new Date(),
          });
          continue;
        }
        if ('failed' in verdict) {
          await runs.update(held, {
            status: 'failed',
            error: verdict.failed.slice(0, 500),
            finishedAt: new Date(),
          });
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
   * A held report that could not be checked on is given up when its title
   * or its server is gone, or once it has been held as long as a report is.
   * Otherwise it is tried again at the next check.
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
    if (now - new Date(run.createdAt).getTime() >= HOLD_LONGEST_MS) {
      return {
        failed: `Not looked into: it could not be checked on for ${
          HOLD_LONGEST_MS / (60 * 60 * 1000)
        } hours (${why}).`,
      };
    }
    return null;
  }

  /**
   * Whether a held report goes ahead: not while Sonarr or Radarr is still
   * searching for the title or Backfill is (for a few hours at most), not
   * when either found something, and not when nothing is missing now.
   */
  private async holdVerdict(
    run: AgentRun,
    now: number
  ): Promise<{ go: true } | { wait: true } | { notNeeded: string }> {
    const young = now - new Date(run.createdAt).getTime() < HOLD_LONGEST_MS;
    const { seasonNumber } = reportOf(run);
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
        if (searching || row?.status === 'searching') return { wait: true };
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
        if (searching || row?.status === 'searching') return { wait: true };
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
   * Finished conversations older than the days kept, gone. A conversation
   * waiting on an answer stays. What a run downloaded is not touched.
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

  /** One conversation gone, unless it is working right now. */
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
    return true;
  }

  /**
   * Every finished conversation gone. Ones waiting on an answer stay, and
   * so do ones whose downloads are still going.
   */
  public async clearFinished(): Promise<number> {
    return deleteFinished({});
  }

  /** Why the agent cannot work for this person now, or null. */
  public problem(user?: User | null): string | null {
    if (!aiFeatureOn('aiAgent', user)) {
      return 'The admin agent needs AI set up, with Admin Agent turned on, in Settings → AI.';
    }
    const ready = backfill.readiness();
    return ready.ready ? null : (ready.problem ?? 'Backfill is not ready.');
  }

  /**
   * An admin's ask, about any title or (from a title's page) about that
   * one, which the run is then bound to from the start.
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
   * An admin's answer, correction or follow-up to a run: it goes on from
   * where it was, with everything it found so far.
   */
  public async reply(id: number, text: string, user: User): Promise<AgentRun> {
    const problem = this.problem(user);
    if (problem) throw new Error(problem);
    const runs = getRepository(AgentRun);
    const run = await runs.findOne({ where: { id } });
    if (!run) throw new Error('There is no such conversation.');
    if (run.status === 'queued' || run.status === 'running') {
      throw new Error('It is still working; reply once it has answered.');
    }
    const said = text.trim().slice(0, MAX_ASK);
    run.steps.push({
      at: new Date().toISOString(),
      kind: 'reply',
      text: `${user.displayName}: ${said}`,
    });
    // Answering instead of approving leaves the proposal undone. An
    // approval a failed run never got to is not carried out now either:
    // the admin approved it for then, not for whenever it is next replied to.
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
    // A run that stopped before its first turn (or a report replied to
    // while held) has no conversation yet: what it was asked comes first.
    const opening = run.conversation.length
      ? ''
      : `${this.firstMessage(run)}\n\n`;
    run.conversation = [
      ...run.conversation,
      {
        role: 'user',
        text: `${opening}${user.displayName} (admin) says: ${said}${
          pending
            ? '\n(What you proposed was not approved and nothing of it was done; propose again if it is still wanted.)'
            : ''
        }${
          undone
            ? '\n(What an admin approved earlier was never done: you stopped before getting to it. Propose it again if it is still wanted.)'
            : ''
        }`,
      },
    ];
    run.status = 'queued';
    run.question = null;
    run.error = null;
    // The rest of the conversation acts as whoever is talking to it now.
    run.requestedById = user.id;
    run.requestedByName = run.requestedByName ?? user.displayName;
    await runs.save(run);
    this.queue.push(run.id);
    void this.pump();
    return run;
  }

  /**
   * An admin approves what a run proposed: it goes on, carrying the changes
   * out first, each checked again against how things are now. Only the
   * proposal shown to them, and only once.
   */
  public async approve(
    id: number,
    proposalId: string,
    user: User
  ): Promise<AgentRun> {
    return this.decide(id, proposalId, user, true);
  }

  /** An admin declines it: nothing is changed, and the run is over. */
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
      if (!run) throw new Error('There is no such conversation.');
      const proposal = proposalOf(run);
      if (run.status !== 'waiting' || !proposal || proposal.id !== proposalId) {
        throw new Error(
          'These changes are no longer waiting; reload to see where it stands.'
        );
      }
      const headlines = proposal.changes.map((c) => c.headline).join('; ');
      const { proposal: _taken, ...memory } = run.memory as {
        proposal?: Proposal;
      };
      void _taken;
      run.question = null;
      run.error = null;
      run.steps.push({
        at: new Date().toISOString(),
        kind: 'reply',
        text: `${user.displayName} ${approved ? 'approved' : 'declined'}: ${headlines}`,
      });
      if (approved) {
        const decision: Decision = {
          by: user.displayName,
          changes: proposal.changes,
        };
        run.memory = { ...memory, decision };
        run.status = 'queued';
        // It carries on as the admin who approved.
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
      await runs.save(run);
      return run;
    } finally {
      this.deciding.delete(id);
    }
  }

  /** Carries out approved changes, one by one; what came of each. */
  private async carryOut(
    decision: Decision,
    state: AgentState
  ): Promise<string> {
    const lines: string[] = [];
    for (const change of decision.changes) {
      try {
        if (change.kind === 'replace') {
          // The grab records itself, as any download it starts.
          const said = await startApprovedGrab(
            state,
            change.params.grab,
            `AI agent, approved by ${decision.by}`
          );
          lines.push(`Done: ${change.headline}. ${said}`);
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
   * Backfill found nothing it could use for a title: look further, if
   * someone asked for it, the agent has not tried it lately, and today's
   * runs are not used up.
   */
  public async afterEmptySearch(row: BackfillSeries): Promise<AgentRun | null> {
    const settings = getSettings().backfill;
    if (!settings.agent.autoRun) return null;
    const user = await owner();
    if (this.problem(user)) return null;
    if (row.agentAutoRunAt) return null;
    if (!(await requestedSince([row])).has(row.id)) return null;
    const runs = getRepository(AgentRun);
    const lately = new Date(Date.now() - settings.researchAfterDays * DAY);
    const recent = await runs.count({
      where: [
        { ...sameTitle(row), createdAt: MoreThan(lately) },
        {
          ...sameTitle(row),
          status: In(UNFINISHED),
        },
      ],
    });
    if (recent) return null;
    const today = await runs.count({
      where: {
        trigger: In(['auto', 'report']),
        createdAt: MoreThan(new Date(Date.now() - DAY)),
      },
    });
    if (today >= settings.agent.maxAutoRunsPerDay) return null;
    const run = await runs.save(
      new AgentRun({
        trigger: 'auto',
        status: 'queued',
        kind: row.kind,
        serverId: row.serverId,
        arrId: row.arrId,
        title: row.title,
        steps: [],
        actions: [],
      })
    );
    this.queue.push(run.id);
    void this.pump();
    return run;
  }

  public isBusy(): boolean {
    return this.running || this.queue.length > 0;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const id = this.queue.shift();
    if (id === undefined) return;
    this.running = true;
    try {
      await this.execute(id);
    } catch (e) {
      logger.error('The admin agent failed', {
        label: LABEL,
        runId: id,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    } finally {
      this.running = false;
      void this.pump();
    }
  }

  private firstMessage(run: AgentRun): string {
    if (
      run.trigger === 'ask' &&
      run.arrId !== null &&
      run.arrId !== undefined
    ) {
      const ref = titleRef({
        kind: run.kind ?? 'series',
        serverId: run.serverId ?? 0,
        arrId: run.arrId,
      });
      return `An admin asked about ${run.title} (${ref}), from its page: ${run.ask}`;
    }
    if (run.trigger === 'ask') {
      return `An admin asked: ${run.ask}\n\nIf it is not in the library, you may request it with request_title, then say it will be searched once Sonarr or Radarr adds it.`;
    }
    const ref = titleRef({
      kind: run.kind ?? 'series',
      serverId: run.serverId ?? 0,
      arrId: run.arrId ?? 0,
    });
    if (run.trigger === 'report') {
      const { seasonNumber } = reportOf(run);
      // Not the reporter's name: they chose it, and it is not for the model
      // to read as anything. The page still shows who it was.
      return `Someone reported that ${run.title} (${ref}) is missing${
        seasonNumber !== undefined ? ` episodes in season ${seasonNumber}` : ''
      }. ${
        run.kind === 'movie' ? 'Radarr' : 'Sonarr'
      } searched again and found nothing usable, and neither did Backfill's search of Prowlarr. Find out what is missing and get it if you can.`;
    }
    return `Someone requested ${run.title} (${ref}). Sonarr or Radarr has not found it for a day or more, and Backfill's search of Prowlarr found nothing it could use on its own. Find out what is missing and get it if you can.`;
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
      if (run.steps.length > MAX_STEPS_KEPT) {
        run.steps.splice(0, run.steps.length - MAX_STEPS_KEPT);
      }
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

      // Downloads count by when each was started, in any conversation: an
      // old one replied to today has no fresh day's worth. A go ends with
      // its finish time set, so any run that started one in the last day
      // finished a go since.
      const dayAgo = Date.now() - DAY;
      const others = await runs.find({
        select: { id: true, actions: true },
        where: { finishedAt: MoreThan(new Date(dayAgo)) },
      });
      const grabsToday = [...others.filter((r) => r.id !== run.id), run].reduce(
        (n, r) =>
          n +
          r.actions.filter(
            (a) => a.type === 'grab' && new Date(a.at).getTime() > dayAgo
          ).length,
        0
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
          if (run.arrId === null || run.arrId === undefined) {
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
      const keep = (messages: ConverseMessage[]) => {
        run.conversation = messages;
        run.memory = {
          ...run.memory,
          releases: Object.fromEntries(state.releases),
        };
      };

      const ai = settings.ai;
      const model = modelFor('aiAgent');
      const tools = TOOLS.filter(
        (tool) => !tool.askOnly || adminPresent(run)
      ).map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      }));
      const standing = settings.backfill.agent.instructions.trim();
      const system = standing
        ? `${SYSTEM}\n\nStanding instructions from the admin, always to be followed:\n${standing}`
        : SYSTEM;
      messages = run.conversation.length
        ? compact(answerCalls(run.conversation as ConverseMessage[]))
        : [{ role: 'user', text: this.firstMessage(run) }];
      const decision = (run.memory as { decision?: Decision }).decision;
      if (decision) {
        // Taken off first: whatever happens, an approval is carried out once.
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
      }
      const maxSteps = settings.backfill.agent.maxSteps;
      // A go that runs out of steps mid-task carries on by itself, while it
      // is getting somewhere: the first time always, after that only when
      // the go before started a download.
      const extraGoes = settings.backfill.agent.autoContinue;
      let goes = 0;
      let actionsAtGo = run.actions.length;
      let used = 0;
      let answer = '';
      let warned = false;

      for (;;) {
        const turn = await converse(ai, {
          model,
          system,
          messages,
          tools,
          maxTokens: TURN_TOKENS,
        });
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
        if (!turn.calls.length || warned) {
          // Told to stop, it may still ask for tools: none is run, and
          // each is answered so, or the conversation could not go on.
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
        // Answers go in as they come back, so that should it stop part way,
        // the ones it has are kept.
        const results: ToolResult[] = [];
        messages.push({ role: 'tool', results });
        // Calls that only look run together (searches can take minutes);
        // anything that changes something runs alone, in the order asked.
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
        for (const batch of batches) {
          const calls = batch.map((call) => {
            step('tool', `${call.name}(${describe(call.input)})`, call.name);
            return { call, at: run.steps[run.steps.length - 1] };
          });
          await runs.save(run);
          let saving: Promise<unknown> = Promise.resolve();
          const answers = await Promise.all(
            calls.map(async ({ call, at }) => {
              const result = await runTool(state, call.name, call.input);
              // Its answer goes right after its call, as it comes back.
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
              if (run.steps.length > MAX_STEPS_KEPT) {
                run.steps.splice(0, run.steps.length - MAX_STEPS_KEPT);
              }
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
      step('error', run.error);
      // An approval it never got to is dropped, not left to be carried out
      // whenever the run is next replied to; the admin is told.
      const { decision: undone, ...rest } = (run.memory ?? {}) as {
        decision?: Decision;
      };
      if (undone) {
        run.memory = rest;
        const note = `What ${undone.by} approved was not done: ${undone.changes
          .map((c) => c.headline)
          .join('; ')}. Reply to have it proposed again.`.slice(0, 500);
        step('error', note);
        run.error = `${run.error}\n\n${note}`;
      }
    } finally {
      // Kept as far as it got, with every call it made answered, so it can
      // be replied to.
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
  }

  /**
   * Whether this go answers the issue a title was reported on: the first
   * go of the report's conversation to finish (one waiting on an admin, or
   * failed, is for admins to see to first). Marks the report answered, so
   * an admin's later follow-ups stay off the issue.
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
   * After each go: the title's history says what the agent did, and a run
   * it started on its own marks the title, as it does that only once per
   * title. After that only an admin starts it.
   */
  private async remember(
    run: AgentRun,
    actions: AgentRun['actions']
  ): Promise<void> {
    if (!run.kind || run.arrId == null) return;
    // A go that ends waiting on an admin is noted for what it did; the rest
    // is noted when the conversation is over.
    const over = run.status === 'done' || run.status === 'failed';
    if (!over && !actions.length) return;
    const own =
      run.trigger === 'auto' ||
      (run.trigger === 'report' && !reportOf(run).byAdmin);
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

  /** A reported title's outcome, on the issue it was reported on. */
  private async answerReport(run: AgentRun): Promise<void> {
    const { issueId } = reportOf(run);
    if (!issueId) return;
    try {
      const issue = await getRepository(Issue).findOne({
        where: { id: issueId },
      });
      const author = await owner();
      if (!issue || !author) return;
      await getRepository(IssueComment).save(
        new IssueComment({
          issue,
          user: author,
          message: `Admin agent: ${(run.summary ?? 'Done.').slice(0, 2000)}`,
        })
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
   * A question goes to admins at once. What it did goes with Backfill's
   * other news, gathered, so one busy run is one notification among them.
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
        actionUrl: `/backfill/agent/${run.id}`,
        actionUrlTitle: proposal ? 'Review' : 'Answer',
      });
      // What it did before it stopped to ask is told as any other go's.
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
      run.kind && run.arrId !== null && run.arrId !== undefined
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

export default agent;
