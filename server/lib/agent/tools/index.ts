import type { AgentRun } from '@server/entity/AgentRun';
import { clip } from '@server/lib/agent/rules';
import {
  askAdmin,
  proposeChange,
  relinkFile,
  replaceSeason,
  requestTitle,
  searchUpgrade,
} from '@server/lib/agent/tools/admin';
import type {
  AgentState,
  AgentTool,
  TitleRef,
} from '@server/lib/agent/tools/base';
import {
  Refused,
  adminPresent,
  readTitleRef,
  titleRef,
} from '@server/lib/agent/tools/base';
import { grab, stopDownload } from '@server/lib/agent/tools/grab';
import {
  checkLanguage,
  releaseFiles,
  searchIndexers,
  searchReleases,
} from '@server/lib/agent/tools/search';
import { findTitle, titleStatus } from '@server/lib/agent/tools/titles';
import { z } from 'zod';

export {
  Refused,
  ToolError,
  adminPresent,
  boundTitle,
  decisionText,
  mayReplace,
  readTitleRef,
  titleMatches,
  titleRef,
} from '@server/lib/agent/tools/base';
export type {
  AgentState,
  AgentTool,
  KnownRelease,
  TitleRef,
} from '@server/lib/agent/tools/base';
export { startApprovedGrab } from '@server/lib/agent/tools/grab';
export type { GrabInput } from '@server/lib/agent/tools/grab';
export {
  forgetSearches,
  notLookedFor,
  searchTiming,
} from '@server/lib/agent/tools/search';
export type { MadeCall } from '@server/lib/agent/tools/search';
export { lookups } from '@server/lib/agent/tools/titles';

/*
 * What the admin agent can do: look titles up, read what they lack, search
 * the way Sonarr, Radarr and Lidarr do (with their reasons for turning
 * results down) and the way Prowlarr does, open a release to see its files,
 * and start a download of exactly the files it chose, mapped to the
 * episodes they are (an album's files are matched to its tracks by
 * Backfill). Downloads go through Backfill, which waits for disk space,
 * fetches only those files and has Sonarr, Radarr or Lidarr import each one
 * as what it was mapped to.
 *
 * Releases and titles are named by short references ("r3",
 * "series:1:1283"); links, keys and paths on the server never reach the
 * model.
 */

export const TOOLS: AgentTool[] = [
  findTitle,
  titleStatus,
  searchReleases,
  searchIndexers,
  releaseFiles,
  checkLanguage,
  grab,
  stopDownload,
  relinkFile,
  askAdmin,
  requestTitle,
  searchUpgrade,
  replaceSeason,
  proposeChange,
];

/**
 * Why a run with no admin in it may not use a tool on this title, or null.
 * Such a run (started on its own, or for someone's report) is about its one
 * title: what it reads (release names, file paths) cannot send it to work
 * on another.
 */
const elsewhere = (
  run: AgentRun,
  input: Record<string, unknown>
): string | null => {
  if (adminPresent(run) || run.arrId === null || run.arrId === undefined) {
    return null;
  }
  if (input.title === undefined) return null;
  let asked: TitleRef;
  try {
    asked = readTitleRef(input.title);
  } catch {
    // Not a reference at all: the tool says so itself.
    return null;
  }
  const own = titleRef({
    kind: run.kind ?? 'series',
    serverId: run.serverId ?? 0,
    arrId: run.arrId,
  });
  return titleRef(asked) === own
    ? null
    : `This conversation is only about ${run.title ?? 'its title'} (${own}). No admin is in it, so no other title is looked at or changed.`;
};

/** Runs one tool for the model: its answer, or why it could not. */
export const runTool = async (
  state: AgentState,
  name: string,
  input: Record<string, unknown>
): Promise<{ text: string; isError: boolean; refused?: boolean }> => {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool || (tool.askOnly && !adminPresent(state.run))) {
    return { text: `There is no tool called ${name}.`, isError: true };
  }
  const refused = elsewhere(state.run, input);
  if (refused) return { text: refused, isError: true };
  try {
    return { text: clip(await tool.run(state, input)), isError: false };
  } catch (e) {
    const why =
      e instanceof z.ZodError
        ? `The input was not right: ${e.issues
            .map((i) => `${i.path.join('.')} ${i.message}`)
            .join('; ')}`
        : e instanceof Error
          ? e.message
          : String(e);
    return {
      text: clip(why, 1500),
      isError: true,
      ...(e instanceof Refused ? { refused: true } : {}),
    };
  }
};
