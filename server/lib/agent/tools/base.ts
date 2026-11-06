import type { ProwlarrRelease } from '@server/api/prowlarr';
import type { LidarrAlbum } from '@server/api/servarr/lidarr';
import type { AgentAction, AgentRun, AgentStep } from '@server/entity/AgentRun';
import type { User } from '@server/entity/User';
import type { ProposedChange } from '@server/lib/agent/changes';
import type { ConverseTool } from '@server/lib/ai/providers';
import type { PackFile } from '@server/lib/backfill/matcher';
import type { RadarrMovieDetail } from '@server/lib/backfill/radarr';
import type { SonarrSeriesDetail } from '@server/lib/backfill/sonarr';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';

/*
 * Shared by every admin-agent tool: run state, title references, and
 * whether an admin is in the conversation.
 */

/** A release found during a run, named by its reference. */
export interface KnownRelease extends ProwlarrRelease {
  ref: string;
  source: 'sonarr' | 'radarr' | 'lidarr' | 'prowlarr';
  /**
   * Set when opened: a Usenet post in archives or with scrambled names,
   * whose files can't be listed before download.
   */
  packed?: 'archives' | 'scrambled';
}

export interface TitleRef {
  kind: 'series' | 'movie' | 'album';
  serverId: number;
  arrId: number;
}

/** State of one run. */
export interface AgentState {
  run: AgentRun;
  /** Who it acts as: the admin who asked, or the owner. */
  user: User;
  releases: Map<string, KnownRelease>;
  files: Map<string, PackFile[]>;
  series: Map<number, SonarrSeriesDetail[]>;
  movies: Map<number, RadarrMovieDetail[]>;
  /** Each Lidarr's albums and artist names, read once per run. */
  albums?: Map<number, LibraryAlbums>;
  /** Downloads started in the last day, this run's included. */
  grabsToday: number;
  /** Ties the run to the first library title it works on. */
  bind(title: TitleRef, name: string): void;
  act(action: AgentAction): void;
  /** Pauses the run with a question for an admin. */
  ask(question: string): void;
  /**
   * Proposes a change for an admin to approve or decline. The run pauses
   * after this turn's tools, with every change proposed in it.
   */
  propose(change: ProposedChange): void;
}

/** A Lidarr's albums, and artist names by id. */
export interface LibraryAlbums {
  albums: LidarrAlbum[];
  artists: Map<number, string>;
}

/** A refusal reported to the model so it tries something else. */
export class ToolError extends Error {}

/**
 * A release refused for what it is (a foreign dub), not how it was asked
 * for. Remembered for the title so later conversations skip it.
 */
export class Refused extends ToolError {}

export interface AgentTool extends ConverseTool {
  /** Offered only with an admin in the conversation. */
  askOnly?: boolean;
  /**
   * Changes something with no approval step: with an admin present, only
   * on the conversation's own title or one an admin named.
   */
  acts?: boolean;
  /** Read-only; several in one turn run in parallel. */
  readOnly?: boolean;
  run(state: AgentState, input: Record<string, unknown>): Promise<string>;
}

// ---- the run ----------------------------------------------------------------

/** An admin's decision on a proposal, as its step text. */
export const decisionText = (
  by: string,
  approved: boolean,
  headlines: string
): string => `${by} ${approved ? 'approved' : 'declined'}: ${headlines}`;

/**
 * Whether a reply step is a decision rather than an admin's message. Steps
 * saved before decisions were marked are told by their text, any that could
 * be one counting as one.
 */
const isDecision = (step: AgentStep): boolean =>
  step.decision ?? / (approved|declined): /.test(step.text ?? '');

/** What admins said in replies, without their decisions on proposals. */
export const adminReplies = (run: AgentRun): string[] =>
  run.steps
    .filter((step) => step.kind === 'reply' && !isDecision(step))
    .map((step) => step.text);

/**
 * Whether an admin is in the conversation: they asked, or replied since.
 * Only then may the run propose changes or request titles. Approving a
 * proposal is not a reply, so a run that read release names on its own
 * gains no extra say.
 */
export const adminPresent = (run: AgentRun): boolean =>
  run.trigger === 'ask' ||
  run.steps.some((step) => step.kind === 'reply' && !isDecision(step));

/**
 * Whether this go of the run follows an admin's word (their ask or a
 * reply), not a failed download it was sent back to look at on its own.
 */
export const adminDriven = (run: AgentRun): boolean => {
  for (let i = run.steps.length - 1; i >= 0; i--) {
    const step = run.steps[i];
    if (step.kind === 'followUp') return false;
    if (step.kind === 'reply' && !isDecision(step)) return true;
  }
  return run.trigger === 'ask';
};

/**
 * Whether an admin named this title in the conversation: every word of
 * one of its names (a year or country after it aside) is in their ask or
 * one of their replies.
 */
export const namedByAdmin = (
  run: AgentRun,
  ...names: (string | undefined)[]
): boolean => {
  const said = [
    ...(run.trigger === 'ask' && run.ask ? [run.ask] : []),
    ...adminReplies(run),
  ];
  return names.some((name) => {
    if (!name) return false;
    const bare = name.replace(/\s*\([^)]*\)\s*$/, '');
    return !!normalize(bare) && titleMatches(bare, ...said);
  });
};

/** Someone reported the files bad and asked for them to be replaced. */
export const replaceReported = (run: AgentRun): boolean =>
  !!(run.memory as { report?: { replace?: boolean } } | null)?.report?.replace;

/**
 * Whether replacing files may be proposed: with an admin in the
 * conversation, or for a report asking for it. Nothing is replaced before
 * an admin approves.
 */
export const mayReplace = (run: AgentRun): boolean =>
  adminPresent(run) || replaceReported(run);

// ---- titles ----------------------------------------------------------------

export const titleRef = (title: TitleRef) =>
  `${title.kind}:${title.serverId}:${title.arrId}`;

export const readTitleRef = (value: unknown): TitleRef => {
  const match = /^(series|movie|album):(\d+):(\d+)$/.exec(String(value ?? ''));
  if (!match) {
    throw new ToolError(
      'That is not a title reference. Use one find_title gave, like series:1:1283.'
    );
  }
  return {
    kind: match[1] as TitleRef['kind'],
    serverId: Number(match[2]),
    arrId: Number(match[3]),
  };
};

/** Non-4K servers (all if none); a 4K twin is the same library. */
export const mainServers = <T extends SonarrSettings | RadarrSettings>(
  servers: T[]
): T[] => {
  const main = servers.filter((s) => !s.is4k);
  return main.length ? main : servers;
};

export const normalize = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Every word of the query is in the title, in any order. */
export const titleMatches = (query: string, ...titles: string[]) => {
  const words = normalize(query).split(' ').filter(Boolean);
  if (!words.length) return false;
  return titles.some((title) => {
    const have = ` ${normalize(title)} `;
    return words.every((word) => have.includes(` ${word} `));
  });
};

/** The title a run is bound to, once it is. */
export const boundTitle = (run: AgentRun): TitleRef | null =>
  run.kind && run.arrId != null
    ? { kind: run.kind, serverId: run.serverId ?? 0, arrId: run.arrId }
    : null;

/**
 * A series' original language. Anime with none recorded is taken as
 * Japanese, since the original is wanted and an English dub may not exist.
 */
export const originalOf = (series: {
  originalLanguage?: { name: string };
  seriesType?: string;
}): string | undefined =>
  series.originalLanguage?.name ??
  (series.seriesType === 'anime' ? 'Japanese' : undefined);
