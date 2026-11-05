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
 * The admin agent's tools: look titles up, read what they lack, search via
 * Sonarr, Radarr and Lidarr (with their rejection reasons) and Prowlarr,
 * list a release's files, and download exactly the chosen files mapped to
 * episodes (Backfill matches an album's files to tracks). Backfill waits for
 * disk space, fetches only those files and has the *arr import each as
 * mapped.
 *
 * Releases and titles are named by short references ("r3",
 * "series:1:1283"); server links, keys and paths never reach the model.
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
 * Why a run without an admin may not use a tool on this title, or null.
 * Such a run (automatic, or from a report) is confined to its own title, so
 * what it reads (release names, file paths) cannot steer it to another.
 */
const elsewhere = (
  run: AgentRun,
  input: Record<string, unknown>
): string | null => {
  if (adminPresent(run) || run.arrId == null) return null;
  if (input.title === undefined) return null;
  let asked: TitleRef;
  try {
    asked = readTitleRef(input.title);
  } catch {
    // Not a reference: the tool reports that itself.
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

/** Runs one tool for the model, returning its output or why it failed. */
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
