import type { ChangeIcon } from '@app/components/Backfill/Agent/work';
import defineMessages from '@app/utils/defineMessages';
import type { MessageDescriptor } from 'react-intl';

/** Each kind of change in a few words (see work.ts). */
export const changeMessages: Record<
  ChangeIcon | 'addedToDownload',
  MessageDescriptor
> = defineMessages('components.Backfill.Agent.changes', {
  download: 'Started a download',
  addedToDownload: 'Added files to a download',
  request: 'Requested it',
  stop: 'Stopped a download',
  link: 'Linked a file to its episodes',
  delete: 'Deleted files',
  block: 'Blocked a release group',
  unblock: 'Unblocked a release group',
  failed: 'Marked a download failed',
  profile: 'Changed the quality profile',
  replace: 'Replaced a file',
  done: 'Made a change',
});
