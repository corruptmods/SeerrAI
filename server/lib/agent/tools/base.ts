import type { ProwlarrRelease } from '@server/api/prowlarr';
import type { LidarrAlbum } from '@server/api/servarr/lidarr';
import type { AgentAction, AgentRun } from '@server/entity/AgentRun';
import type { User } from '@server/entity/User';
import type { ProposedChange } from '@server/lib/agent/changes';
import type { ConverseTool } from '@server/lib/ai/providers';
import type { PackFile } from '@server/lib/backfill/matcher';
import type { RadarrMovieDetail } from '@server/lib/backfill/radarr';
import type { SonarrSeriesDetail } from '@server/lib/backfill/sonarr';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';

/*
 * What every tool of the admin agent shares: what a run knows, how
 * titles are named, and whether an admin is in the conversation.
 */

/** A release found during a run, named by its reference. */
export interface KnownRelease extends ProwlarrRelease {
  ref: string;
  source: 'sonarr' | 'radarr' | 'lidarr' | 'prowlarr';
  /**
   * A Usenet post in archives, or with scrambled file names, found when it
   * was opened: its files can't be listed before it is downloaded.
   */
  packed?: 'archives' | 'scrambled';
}

export interface TitleRef {
  kind: 'series' | 'movie' | 'album';
  serverId: number;
  arrId: number;
}

/** What one run knows as it goes. */
export interface AgentState {
  run: AgentRun;
  /** Who it acts as: the admin who asked, or the owner. */
  user: User;
  releases: Map<string, KnownRelease>;
  files: Map<string, PackFile[]>;
  series: Map<number, SonarrSeriesDetail[]>;
  movies: Map<number, RadarrMovieDetail[]>;
  /** Each Lidarr's albums, with its artists' names, read once a run. */
  albums?: Map<number, LibraryAlbums>;
  /** Downloads started in the last day, this run's included. */
  grabsToday: number;
  /** Ties the run to the first library title it works on. */
  bind(title: TitleRef, name: string): void;
  act(action: AgentAction): void;
  /** Pauses the run with a question for an admin. */
  ask(question: string): void;
  /**
   * Puts a change to an admin, to approve or decline: the run pauses once
   * this turn's tools are done, with every change proposed in it.
   */
  propose(change: ProposedChange): void;
}

/** A Lidarr's albums, and the names of their artists by id. */
export interface LibraryAlbums {
  albums: LidarrAlbum[];
  artists: Map<number, string>;
}

/** A refusal the model is told about, to try something else. */
export class ToolError extends Error {}

/**
 * A release turned down for what it is (a dub in another language), not
 * for how it was asked for: remembered for the title, so later
 * conversations don't try it again.
 */
export class Refused extends ToolError {}

export interface AgentTool extends ConverseTool {
  /** Only when an admin asked, never on its own. */
  askOnly?: boolean;
  /** Only looks; several in one turn run at the same time. */
  readOnly?: boolean;
  run(state: AgentState, input: Record<string, unknown>): Promise<string>;
}

// ---- the run ----------------------------------------------------------------

/** An admin's decision on what a run proposed, as its step says it. */
export const decisionText = (
  by: string,
  approved: boolean,
  headlines: string
): string => `${by} ${approved ? 'approved' : 'declined'}: ${headlines}`;

/** Whether a reply step is a decision, not something an admin said. */
const isDecision = (text: string | undefined): boolean => {
  const said = text ?? '';
  const end = said.indexOf(': ');
  return end > 0 && / (approved|declined)$/.test(said.slice(0, end));
};

/**
 * Whether an admin is in the conversation: they asked, or have replied
 * since. Only then may it propose changes or request titles. Approving
 * what it proposed is not replying: a run that read release names on its
 * own gets no more say for it.
 */
export const adminPresent = (run: AgentRun): boolean =>
  run.trigger === 'ask' ||
  run.steps.some((step) => step.kind === 'reply' && !isDecision(step.text));

/** Someone reported the files bad and asked for them to be replaced. */
export const replaceReported = (run: AgentRun): boolean =>
  !!(run.memory as { report?: { replace?: boolean } } | null)?.report?.replace;

/**
 * Whether replacing files may be proposed: with an admin in the
 * conversation, or for a report asking for it. Either way it only waits
 * for an admin's approval; nothing is replaced before that.
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

/** The main servers: a 4K twin of one is the same library. */
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
  run.kind && run.arrId !== null && run.arrId !== undefined
    ? { kind: run.kind, serverId: run.serverId ?? 0, arrId: run.arrId }
    : null;

/**
 * A series' original language. Anime with none recorded is taken as
 * Japanese: its English dub may not exist, and the original is wanted.
 */
export const originalOf = (series: {
  originalLanguage?: { name: string };
  seriesType?: string;
}): string | undefined =>
  series.originalLanguage?.name ??
  (series.seriesType === 'anime' ? 'Japanese' : undefined);
