import Button from '@app/components/Common/Button';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import { NoSymbolIcon, XMarkIcon } from '@heroicons/react/24/outline';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages(
  'components.Settings.SettingsBackfill.BlockedGroups',
  {
    title: 'Blocked release groups',
    description:
      'Releases from these groups are never taken: Backfill and the admin agent pass over them, and Radarr and Sonarr get a custom format, "Seerr AI: blocked release groups", that every quality profile scores too low to accept. A file already there from one of them is replaced by the next good release, once that has imported. Changes apply straight away.',
    none: 'No groups are blocked.',
    group: 'Release group',
    placeholder: 'As in release names, like rothebehap',
    add: 'Block',
    adding: 'Blocking…',
    remove: 'Unblock {group}',
    blocked: '{group} is blocked.',
    unblocked: '{group} is unblocked.',
    notEverywhere: 'Saved, but not every server took it: {problems}',
    failed: 'That could not be changed.',
    invalid:
      'A group name is letters, numbers, dots, dashes or spaces, up to 60.',
  }
);

/** What release names carry after the dash; checked again on the server. */
const GROUP_NAME = /^[\w][\w.\- ]{0,59}$/;

/**
 * The blocked release groups, changed one at a time: each change is saved
 * and sent to Radarr and Sonarr at once, apart from the form's Save. The
 * list is kept here, from each answer, so the settings form above is not
 * reloaded under unsaved edits.
 */
const BlockedGroups = ({ initial }: { initial: string[] }) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [groups, setGroups] = useState(initial);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const change = async (group: string, blocked: boolean) => {
    setBusy(true);
    try {
      const { data } = await axios.post<{
        groups: string[];
        problems: string[];
      }>('/api/v1/settings/backfill/blocked-groups', { group, blocked });
      setGroups(data.groups);
      if (data.problems.length) {
        addToast(
          intl.formatMessage(messages.notEverywhere, {
            problems: data.problems.join(' '),
          }),
          { appearance: 'warning', autoDismiss: false }
        );
      } else {
        addToast(
          intl.formatMessage(blocked ? messages.blocked : messages.unblocked, {
            group,
          }),
          { appearance: 'success', autoDismiss: true }
        );
      }
      if (blocked) setName('');
    } catch (e) {
      addToast(
        axios.isAxiosError(e) && e.response?.data?.message
          ? String(e.response.data.message)
          : intl.formatMessage(messages.failed),
        { appearance: 'error', autoDismiss: true }
      );
    } finally {
      setBusy(false);
    }
  };

  const typed = name.trim();
  const valid = GROUP_NAME.test(typed);

  return (
    <section aria-labelledby="blocked-groups" className="mt-10">
      <h3 id="blocked-groups" className="heading">
        {intl.formatMessage(messages.title)}
      </h3>
      <p className="description">{intl.formatMessage(messages.description)}</p>
      <div className="section">
        {groups.length ? (
          <ul className="flex flex-wrap gap-2">
            {groups.map((group) => (
              <li
                key={group}
                className="flex items-center gap-1 rounded-full bg-gray-700 py-1 pl-3 pr-1 text-sm text-gray-100 ring-1 ring-gray-600"
              >
                <NoSymbolIcon className="h-4 w-4 flex-none text-red-400" />
                <span className="break-all">{group}</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void change(group, false)}
                  aria-label={intl.formatMessage(messages.remove, { group })}
                  title={intl.formatMessage(messages.remove, { group })}
                  className="rounded-full p-1 text-gray-400 hover:bg-gray-600 hover:text-white disabled:opacity-50"
                >
                  <XMarkIcon className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-gray-400">
            {intl.formatMessage(messages.none)}
          </p>
        )}
        <form
          className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-start"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && !busy) void change(typed, true);
          }}
        >
          <div className="min-w-0 flex-1">
            <label htmlFor="blocked-group" className="sr-only">
              {intl.formatMessage(messages.group)}
            </label>
            <input
              id="blocked-group"
              type="text"
              value={name}
              maxLength={60}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setName(e.target.value)}
              placeholder={intl.formatMessage(messages.placeholder)}
            />
            {typed && !valid && (
              <p className="mt-1 text-sm text-red-400">
                {intl.formatMessage(messages.invalid)}
              </p>
            )}
          </div>
          <Button
            buttonType="danger"
            type="submit"
            disabled={busy || !valid}
            className="flex-none"
          >
            <NoSymbolIcon />
            <span>
              {intl.formatMessage(busy ? messages.adding : messages.add)}
            </span>
          </Button>
        </form>
      </div>
    </section>
  );
};

export default BlockedGroups;
