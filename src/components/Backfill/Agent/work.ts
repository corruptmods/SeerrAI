import type { AgentAction } from '@server/entity/AgentRun';

/*
 * The agent's work in plain words. Its tools have names made for the model
 * (find_title, search_releases); an admin reading a conversation is told
 * what it did instead: "found the title, searched for releases". The words
 * themselves are in toolMessages.ts and changeMessages.ts; this says which
 * to use.
 */

/** Every tool the agent has, each with its own words. */
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

/** Which words a tool is told in; anything new is "did something else". */
export const toolWords = (tool?: string): ToolWords =>
  (TOOL_WORDS as readonly string[]).includes(tool ?? '')
    ? (tool as ToolWords)
    : 'other';

/** The kinds of change it can make, each with its own icon. */
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

/** Which icon a change is shown with: a delete is a bin, not a download. */
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
    default:
      return 'done';
  }
};

/** Which few words a change is told in where it happened. */
export const changeWords = (
  action: ActionKind & Pick<AgentAction, 'extended'>
): ChangeIcon | 'addedToDownload' =>
  action.type === 'grab' && action.extended
    ? 'addedToDownload'
    : changeIcon(action);

/**
 * The conversation records each change in its own words; this finds the
 * change each one is, in order, so it can be shown with its icon. Two
 * changes in the same words are matched one each.
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
