import type { AgentAction } from '@server/entity/AgentRun';

/*
 * Maps agent tool names and changes to admin-facing words, which live in
 * toolMessages.ts and changeMessages.ts.
 */

/** Agent tools that have their own words. */
export const TOOL_WORDS = [
  'find_title',
  'title_status',
  'search_releases',
  'search_indexers',
  'release_files',
  'check_language',
  'grab',
  'stop_download',
  'relink_file',
  'ask_admin',
  'request_title',
  'search_upgrade',
  'propose_change',
  'replace_season',
] as const;

export type ToolWords = (typeof TOOL_WORDS)[number] | 'other';

/** A tool's words key; unknown tools map to "did something else". */
export const toolWords = (tool?: string): ToolWords =>
  (TOOL_WORDS as readonly string[]).includes(tool ?? '')
    ? (tool as ToolWords)
    : 'other';

export type ChangeIcon =
  | 'download'
  | 'request'
  | 'stop'
  | 'link'
  | 'delete'
  | 'block'
  | 'unblock'
  | 'failed'
  | 'profile'
  | 'replace'
  | 'done';

type ActionKind = Pick<AgentAction, 'type' | 'change'>;

/** A change's icon; deletes get a bin, not a download arrow. */
export const changeIcon = (action: ActionKind): ChangeIcon => {
  switch (action.type) {
    case 'grab':
      return 'download';
    case 'request':
      return 'request';
    case 'stop':
      return 'stop';
    case 'relink':
      return 'link';
  }
  switch (action.change) {
    case 'deleteFiles':
      return 'delete';
    case 'blockGroup':
      return 'block';
    case 'unblockGroup':
      return 'unblock';
    case 'markFailed':
      return 'failed';
    case 'changeProfile':
      return 'profile';
    case 'replace':
      return 'replace';
    case 'oversizeGrab':
      return 'download';
    default:
      return 'done';
  }
};

/** Short label for a change, shown inline in the conversation. */
export const changeWords = (
  action: ActionKind & Pick<AgentAction, 'extended'>
): ChangeIcon | 'addedToDownload' =>
  action.type === 'grab' && action.extended
    ? 'addedToDownload'
    : changeIcon(action);

/**
 * Returns a matcher from recorded change text to its action; each action
 * matches once, in order.
 */
export const matchActions = <T extends Pick<AgentAction, 'detail'>>(
  actions: T[]
): ((text: string) => T | undefined) => {
  const left = [...actions];
  return (text) => {
    const i = left.findIndex((action) => action.detail === text);
    return i < 0 ? undefined : left.splice(i, 1)[0];
  };
};
