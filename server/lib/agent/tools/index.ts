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
  adminDriven,
  adminPresent,
  namedByAdmin,
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
import { findTitle, nameOf, titleStatus } from '@server/lib/agent/tools/titles';
import { z } from 'zod';

export {
  Refused,
  ToolError,
  adminDriven,
  adminPresent,
  boundTitle,
  decisionText,
  mayReplace,
  namedByAdmin,
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
  prowlarrUnavailable,
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
 * Whether the model is offered a tool now. Tools that need an admin need
 * one in the conversation, and those that change something unapproved
 * need this go to follow an admin's word, not a failed download alone.
 */
export const offered = (tool: AgentTool, run: AgentRun): boolean =>
  !tool.unavailable?.() &&
  (!tool.askOnly || (adminPresent(run) && (!tool.acts || adminDriven(run))));

/**
 * Why a run may not use a tool on this title, or null. A run without an
 * admin (automatic, or from a report) is confined to its own title, so
 * what it reads (release names, file paths) cannot steer it to another.
 * With an admin, a tool that changes something unapproved may act on
 * another title only once an admin has named it.
 */
const elsewhere = async (
  run: AgentRun,
  tool: AgentTool,
  input: Record<string, unknown>
): Promise<string | null> => {
  if (run.arrId == null || input.title === undefined) return null;
  const present = adminPresent(run);
  if (present && !tool.acts) return null;
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
  if (titleRef(asked) === own) return null;
  if (!present) {
    return `This conversation is only about ${run.title ?? 'its title'} (${own}). No admin is in it, so no other title is looked at or changed.`;
  }
  const name = await nameOf(asked).catch(() => null);
  if (name && namedByAdmin(run, name)) return null;
  return `This conversation is about ${run.title ?? 'its title'} (${own}), and no admin has named ${name ?? 'that title'} in it, so nothing is done to it. If it should be, ask the admin (ask_admin); it can be done once an admin names it in a reply.`;
};

/** Runs one tool for the model, returning its output or why it failed. */
export const runTool = async (
  state: AgentState,
  name: string,
  input: Record<string, unknown>
): Promise<{ text: string; isError: boolean; refused?: boolean }> => {
  const tool = TOOLS.find((t) => t.name === name);
  // A tool the settings rule out says why, so the model stops asking.
  const unavailable = tool?.unavailable?.();
  if (unavailable) return { text: unavailable, isError: true };
  if (!tool || !offered(tool, state.run)) {
    return { text: `There is no tool called ${name}.`, isError: true };
  }
  const refused = await elsewhere(state.run, tool, input);
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
