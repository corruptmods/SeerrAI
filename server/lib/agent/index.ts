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
  requestedSince,
  startedByAgent,
} from '@server/lib/backfill/engine';
import { releaseGroup } from '@server/lib/backfill/naming';
import backfillNotices from '@server/lib/backfill/notices';
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
/**
 * Waits before each new try while the AI service can't be reached, is busy
 * or too slow, all within the run: about eight minutes in all.
 */
const OUTAGE_WAITS_MS = [15_000, 30_000, 60_000, 120_000, 240_000];
/**
 * A run that failed so is picked up again once the service answers: asked
 * this often, for up to a day after the run first lost it.
 */
const OUTAGE_CHECK_MS = 5 * 60 * 1000;
const OUTAGE_LONGEST_MS = DAY;
/** A replaced season is followed this long for its new files to import. */
const FOLLOW_LONGEST_MS = 2 * 24 * 60 * 60 * 1000;
const UNFINISHED: AgentRun['status'][] = [
  'held',
  'queued',
  'running',
  'waiting',
];
/**
 * A run that failed for want of the AI service, waiting for it to answer:
 * since when it first lost it. `lostSince` stays on a run picked up again,
 * so losing it again doesn't start its day afresh.
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
 * Replacements of a failed download (for the same episodes) that may fail
 * in a day before the agent stops looking for more and tells admins.
 */
const MAX_FAILED_REPLACEMENTS = 3;
/**
 * The runs that are its own looking: they count towards the runs it starts
 * in a day. One that went on after a failed download is still the run it was.
 */
const COUNTED: AgentRun['purpose'][] = ['work', 'retry'];
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
  /** The files are there but bad: they are to be replaced, not filled. */
  replace?: boolean;
  /**
   * Not a search: a replaced season, followed until its new files have
   * imported, to tell whoever reported it.
   */
  follow?: { episodeIds: number[] };
}

/** What a run asked of an admin without the model, from a report. */
interface DirectMemory {
  /** Approved, its change is made and the run ends; no model is asked. */
  direct?: boolean;
}

const directOf = (run: AgentRun): boolean =>
  !!(run.memory as DirectMemory | null)?.direct && !run.conversation.length;

/** Downloads it started that failed, which it was told to look again for. */
interface FollowUpMemory {
  /** Told, and not yet settled: replaced, or nothing else found. */
  lookingFor?: number[];
}

const lookingForOf = (run: AgentRun): number[] =>
  (run.memory as FollowUpMemory | null)?.lookingFor ?? [];

/**
 * "S06E03", "S06E01-E02, S06E05", "the movie" or "4 tracks": what a
 * download was for.
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

const pad = (n: number) => String(n).padStart(2, '0');

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
  await stopLooking(ids);
  return result.affected ?? ids.length;
};

/**
 * Failed downloads that deleted conversations were to look again for: with
 * the conversation gone, nothing else will be found.
 */
const stopLooking = (runIds: number[]) =>
  getRepository(BackfillJob).update(
    { agentRunId: In(runIds), followUp: 'agent' },
    { followUp: 'none' }
  );

/** Whether it has already looked for this title on its own. */
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
/** Room for its thinking out loud and a tool call or two. */
const TURN_TOKENS = 1500;

const SYSTEM = `You are the admin agent of a home media server run with Seerr, Sonarr, Radarr, Lidarr, Prowlarr and Backfill. You work like a careful admin by hand: get missing episodes, movies and albums downloaded when the automatic searches could not. An admin talks with you in a chat; do what they ask, including extra checks or changes of plan, and keep to it for the rest of the conversation.

How to work:
1. Find the title (find_title) and read what it lacks (title_status).
2. Search two ways. search_releases is Sonarr's or Radarr's own search; the reasons they turned results down show problems you can work around: a wrong year or odd name, the collection's own episode numbering, a size limit, a quality the profile does not want. search_indexers searches Prowlarr directly with any words: try other names, the year, "complete", "collection", a season, the original title. Searches take a while, so ask for the ones you want together in one turn: they run at the same time. For anime, Sonarr's search is slow and goes episode by episode; search_indexers with the English and the original (romaji) names is usually quicker, and fansub releases often number episodes across all seasons. Search one episode a search, by its number and its title ("Show S03E04 Title"), and by the title alone when that finds nothing; a search naming several episodes finds nothing. Specials (season 0) are seldom named S00E01: search for each by the show's name and its title first ("Show Title"). Releases often number episodes their own way (a special counted as episode 1, the scene's seasons): the results say which library episode each is by its title, and when its number and its title disagree, the title is right. A season pack is opened with release_files and each file mapped by its title, never grabbed blind.
3. Steps are limited, so do not spend them on what you already know. A release whose name plainly says it is one missing episode, with no other language in its name, needs neither release_files nor check_language: grab it. Grab several in the same turn. When the admin tells you to start what you found, grab it at once, without checking again what you checked earlier in this conversation. Before you grab a release with several files, or one whose name does not plainly say which episode it is, open it with release_files. Map each file to an episode by its number AND its title. Collections often number files in their own order (shorts or specials first, or one numbering across seasons): compare each file's title with the episode titles from title_status, and never trust the numbers alone.
4. Be certain before you grab. Check the language with check_language when there is any question. Grab only files for missing episodes. One file per episode is preferred: take a release whose files each hold several episodes (S06E01-02, "Title A + Title B") only when no release has those episodes one per file, and then give each such file every episode it holds (episodes: [1, 2]), so Sonarr names it S06E01-E02. Weigh it in this order: the right content; English or the title's original language; covering as much as possible; quality; size. When nothing meets the quality profile, a lower quality is fine as a stopgap, since Sonarr and Radarr keep looking for upgrades. Prefer a well-seeded torrent or usenet.
5. Turn down dubs in other languages (TRUEFRENCH, iTALiAN, GERMAN and so on, unless that is the original language), fakes (sizes far too small, torrents of archives or executables only), samples, and other shows. A Usenet post packed in archives, or with scrambled file names (only its PAR2 repair files named), is normal but cannot be opened: when its name is exactly one missing episode, or the movie, grab it whole (whole: true); a season pack like that cannot be used.
6. If the admin says something you started is wrong, stop it with stop_download and fix it. A file already imported that holds several episodes but is linked to only one (title_status shows the others missing, the file's name or length says it holds them) is fixed with relink_file, when an admin is in the conversation; nothing is downloaded. If nothing usable exists, say so and what you tried. Only ask the admin (ask_admin) when you truly cannot decide yourself.
7. When the admin asks you to change what is already there, propose it; the admin approves or declines, and nothing happens before that. A bad or wrong file: find a good release and grab it with replace: true (the old file goes only once the new one has imported), or search_upgrade to let Radarr or Sonarr find something better by its profile. A whole season that is bad, or that they want replaced or downloaded again: replace_season (it grabs a new release first and removes the old files only after). A release group they do not want: propose_change blockGroup. A download that is wrong or broken: propose_change markFailed. Files to remove, only when removing them is what they asked for: propose_change deleteFiles; never delete files to replace them, which would leave nothing to play until something is found. Another quality profile: propose_change changeProfile. Propose only what was asked for, then stop and wait; the next message says what was decided and what came of it.
8. Albums (album: references, in Lidarr): title_status lists the tracks of the edition Lidarr imports into, on disk or missing. search_releases is Lidarr's own search; search_indexers with kind music searches Prowlarr's music categories ("Artist Album", the album's name, with the year or FLAC). Grab a release of the album without giving files: Backfill matches its files to the tracks and takes what fills missing ones, or says why nothing does. Prefer the whole album to a few tracks, then the quality Lidarr's profile prefers (lossless before MP3), then a well-seeded torrent or usenet. Turn down compilations and "best of" releases by others, other albums of the artist, and singles when the album is wanted. There is no language to check for music. An album not in Lidarr: find_title with music: true finds it on MusicBrainz, and request_title with album requests it, only when the admin asked for it.

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

/** A series, movie or album (the agent's titles) as its runs are kept by. */
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

/** A conversation that isn't there (deleted, or never was). */
export class NoSuchRun extends Error {}

/** What an admin said or did to a run while it works. */
interface Live {
  /** Who stopped it; it stops before its next step. */
  stopBy?: string;
  /** What admins said, read before its next step. */
  notes: { by: string; text: string }[];
}

/** The most that can wait to be read at once. */
const MAX_NOTES = 10;

/** A run asked to get everything missing, not one particular thing. */
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
  /** When the AI service was last asked whether it answers again. */
  private outageCheckedAt = 0;
  /** Changed only by tests, which can't wait minutes. */
  public outageWaitsMs = OUTAGE_WAITS_MS;

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
    this.holdTimer = setInterval(() => {
      void this.checkHeld();
      void this.checkOutages();
    }, HOLD_CHECK_MS);
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
    /** The files are there but bad, and should be replaced. */
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
    // Only work under way holds a report up: not a change waiting for an
    // admin, a season being followed, or a go looking again by itself.
    if (
      await runs.count({
        where: { ...title, status: In(UNFINISHED), purpose: 'work' },
      })
    ) {
      return null;
    }
    // An admin reporting it is asking; anyone else's report is the agent
    // starting on its own, which it does once per title.
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
   * Puts a change to admins on someone's behalf, without the model: a run
   * waiting for approval, told to admins as any proposal is. Approved, the
   * change is made and the run ends; declined, nothing happens. Null when
   * the agent cannot work, so nobody could approve it.
   */
  public async awaitApproval(input: {
    title: TitleRef;
    name: string;
    change: ProposedChange;
    reporter: User;
    issueId?: number;
    seasonNumber?: number;
    /** What they asked, in their words. */
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
   * Follows a replaced season until its new files have imported, then says
   * so on the issue it was reported on. Checked with the held reports.
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
   * Runs that failed because the AI service couldn't be reached carry on
   * once it answers again: asked every few minutes, without spending
   * anything, for a day after each first lost it.
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
      // Only while it is still as it was: an admin may have replied.
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
   * One turn of the model, tried again while its service can't be reached,
   * is busy or too slow. Null when an admin stopped the run meanwhile.
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
        // A followed season tells whoever reported it how it ended.
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
   * Whether a replaced season is back: every episode a new release was
   * grabbed for has a file again. Given up on after two days.
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
      .map((ep) => `S${pad(ep.seasonNumber)}E${pad(ep.episodeNumber)}`)
      .join(', ');
    return {
      failed: `${season} of ${run.title ?? 'the series'} is not all back after two days: ${names} still ${
        waiting.length === 1 ? 'has' : 'have'
      } no file. An admin can see what happened to the download in Sonarr.`,
    };
  }

  /**
   * Whether a held report goes ahead: not while Sonarr or Radarr is still
   * searching for the title or Backfill is (for a few hours at most), not
   * when either found something, and not when nothing is missing now.
   */
  private async holdVerdict(
    run: AgentRun,
    now: number
  ): Promise<
    { go: true } | { wait: true } | { notNeeded: string } | { failed: string }
  > {
    const report = reportOf(run);
    if (report.follow) return this.followVerdict(run, report.follow, now);
    // Bad files to replace: Sonarr's search for another release is already
    // over, and nothing is missing to wait for.
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
    await stopLooking([id]);
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
    let run = await runs.findOne({ where: { id } });
    if (!run) throw new NoSuchRun('There is no such conversation.');
    const said = text.trim().slice(0, MAX_ASK);
    // Working on it, or waiting its turn: read before its next step. Told
    // apart by what is in hand now, not by the status read above, which a
    // run finishing meanwhile leaves out of date.
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
      // It finished between the read above and now: read it again.
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
    // An admin talking to it makes it their work again.
    if (run.purpose === 'retry') run.purpose = 'work';
    // The rest of the conversation acts as whoever is talking to it now.
    run.requestedById = user.id;
    run.requestedByName = run.requestedByName ?? user.displayName;
    await runs.save(run);
    this.queue.push(run.id);
    void this.pump();
    return run;
  }

  /**
   * Stops a run that is waiting its turn or working, before its next step.
   * What it already started carries on, and it can be replied to later to
   * pick up where it was.
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
    // Out of the queue first, so it cannot start; anything said to it
    // while it waited is kept, for when it is replied to; then read
    // afresh, as nothing else writes it now.
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
      undone
        ? ` What ${undone.by} approved was not done: ${undone.changes
            .map((c) => c.headline)
            .join('; ')}. Reply to have it proposed again.`
        : ''
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
   * What admins said as a run finished, too late for it to read: added to
   * the conversation, each in its sayer's words. A run that finished goes
   * on with it, unless it was stopped; one waiting on an admin keeps its
   * question or proposal, and reads it when it goes on.
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
    const opening = run.conversation.length
      ? ''
      : `${this.firstMessage(run)}\n\n`;
    run.conversation = [
      ...run.conversation,
      {
        role: 'user',
        text: `${opening}${notes
          .map((note) => `${note.by} (admin) says: ${note.text}`)
          .join('\n')}`,
      },
    ];
    if (resume && run.status !== 'waiting') {
      run.status = 'queued';
      run.error = null;
      if (run.purpose === 'retry') run.purpose = 'work';
    }
    await runs.save(run);
    if (resume && run.status === 'queued') this.queue.push(id);
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
      // Asked for on someone's behalf: they hear it was turned down.
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
          // Whoever reported it hears when the season is back.
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
   * The runs it started in the last day without an admin asking: on its
   * own, or for a report. A change waiting for approval and a followed
   * season are not runs of its own.
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
      // Said as it finished, too late to be read: added for it to go on
      // with. Still its run while this is done, so anything said meanwhile
      // waits here too; then let go of at once, nothing in between.
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
      // Not the reporter's name: they chose it, and it is not for the model
      // to read as anything. The page still shows who it was.
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
      // What it does is kept with the title, for later conversations about
      // it, once it knows which title it works on.
      // Each with the title its call named, or else the one it works on.
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
      // Read again each turn: an admin who replies while it works is in the
      // conversation from then on.
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
      // Asked for on someone's behalf, without the model: once approved,
      // the change is made and that is all.
      const direct = directOf(run) && !!decision;
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
        if (direct) {
          answer = `Approved by ${decision.by}. ${outcome}`;
        }
      }
      const maxSteps = settings.backfill.agent.maxSteps;
      // A go that runs out of steps mid-task carries on by itself, while it
      // is getting somewhere: the first time always, after that only when
      // the go before started a download.
      const extraGoes = settings.backfill.agent.autoContinue;
      let goes = 0;
      let actionsAtGo = run.actions.length;
      let used = 0;
      let warned = false;
      // Who stopped it, if an admin did.
      let stoppedBy: string | undefined;
      // Its searches over the whole conversation, to tell what it never
      // looked for; and whether it was told so this time.
      const searched: MadeCall[] = [
        ...((run.memory as { searched?: MadeCall[] }).searched ?? []),
      ];
      let toldWhatsLeft = false;
      const broad =
        run.trigger === 'auto' ||
        (run.trigger === 'report' && !reportOf(run).replace) ||
        BROAD_ASK.test(run.ask ?? '');

      for (; !direct; ) {
        // An admin may stop it or tell it something while it works: read
        // before every step.
        const live = this.live.get(run.id);
        if (live?.stopBy) {
          stoppedBy = live.stopBy;
          break;
        }
        // What earlier conversations tried for the title, told once it is
        // known: at the start, or once it has found the title.
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
            // Set apart from what the admin said: it is Seerr's record.
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
        // Done, by its own account, after searching: first, any missing
        // episode its searches never named is put to it, once, when it was
        // asked for everything.
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
        // Picked up again by itself once the service answers.
        const since = lostSince(run) ?? new Date().toISOString();
        run.memory = { ...withoutOutage(run), outage: { since } };
        run.error = `${run.error} It carries on by itself once the AI service answers again, for up to a day; or reply to have it try now.`;
      } else {
        run.memory = withoutOutage(run);
      }
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
    // Downloads it was looking again for are settled, and any that failed
    // while it worked are handed to it now.
    await this.followFailures(run.id);
  }

  /**
   * A download it started that failed, kept with its title. Best effort:
   * what it does next doesn't wait on it working.
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
   * pack to take its place). It looks again in the same conversation, with
   * the same say as before, unless replacements for the same episodes have
   * failed three times today or its downloads for the day are used up.
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
    // The first of them was the download it was asked for; the rest were
    // replacements.
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
    // Started before downloads kept their conversation: found by what each
    // recent one started.
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
    return runs.reduce(
      (n, r) =>
        n +
        r.actions.filter(
          (a) => a.type === 'grab' && new Date(a.at).getTime() > dayAgo
        ).length,
      0
    );
  }

  /** One at a time, so two failures at once tell a conversation once. */
  private following: Promise<void> = Promise.resolve();

  /**
   * After a go, or when a download it started fails: what it looked again
   * for is settled (replaced, or nothing else found, which admins hear),
   * and failed downloads it has not been told of start a go of their own.
   * Only once a go is over: while it works or waits on an admin, they wait.
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
    // While it works or waits on an admin, the conversation is theirs.
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

    // What it was told of: replaced since, or, once the conversation is
    // over without that, nothing else was found.
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

    // Failed downloads it started that it has not been told of yet.
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
    if (run.steps.length > MAX_STEPS_KEPT) {
      run.steps.splice(0, run.steps.length - MAX_STEPS_KEPT);
    }
    // A conversation never put to the model (a change approved on someone's
    // behalf) starts with what it was asked.
    const opening = run.conversation.length
      ? ''
      : `${this.firstMessage(run)}\n\n`;
    run.conversation = [
      ...run.conversation,
      { role: 'user', text: `${opening}${text}` },
    ];
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

  /** What it is told when downloads it started failed. */
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
    // A change asked for on someone's behalf is not the agent starting on
    // its own, which it does once per title.
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

  /** A reported title's outcome, on the issue it was reported on. */
  private async answerReport(run: AgentRun): Promise<void> {
    await this.comment(
      run,
      `Admin agent: ${(run.summary ?? 'Done.').slice(0, 2000)}`
    );
  }

  /** A comment on the issue a run's title was reported on, if any. */
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

// Told of every failed download it started, from the moment it is loaded.
backfill.onAgentDownloadFailed = (job) => agent.afterFailedDownload(job);

export default agent;
