import type { ToolWords } from '@app/components/Backfill/Agent/work';
import defineMessages from '@app/utils/defineMessages';
import type { MessageDescriptor } from 'react-intl';

/** What each tool did, as an admin is told it (see work.ts). */
export const toolMessages: Record<ToolWords, MessageDescriptor> =
  defineMessages('components.Backfill.Agent.tools', {
    find_title: 'found the title',
    title_status: 'checked what is there',
    search_releases: 'searched for releases',
    search_indexers: 'searched the indexers',
    release_files: 'looked inside a release',
    check_language: 'checked the language',
    grab: 'started a download',
    stop_download: 'stopped a download',
    relink_file: 'linked a file to its episodes',
    ask_admin: 'asked you',
    request_title: 'requested a title',
    search_upgrade: 'looked for a better release',
    propose_change: 'asked to make a change',
    replace_season: 'asked to replace a season',
    other: 'did something else',
  });
