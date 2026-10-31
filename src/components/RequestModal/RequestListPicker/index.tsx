import defineMessages from '@app/utils/defineMessages';
import { BookmarkIcon } from '@heroicons/react/24/outline';
import { useEffect, useRef } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.RequestModal.RequestListPicker', {
  addtolists: 'Also add to',
  alreadyon: 'already on',
});

interface ListSummary {
  kind?: 'watch' | 'music';
  id: number;
  name: string;
}

interface RequestListPickerProps {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  selected: number[];
  onChange: (selected: number[]) => void;
}

/**
 * Lets someone drop a title onto their watch lists as part of requesting it,
 * rather than requesting and then going back to add it.
 *
 * Renders nothing when the user has no lists, so the request modal is
 * unchanged for anyone not using the feature.
 */
const RequestListPicker = ({
  tmdbId,
  mediaType,
  selected,
  onChange,
}: RequestListPickerProps) => {
  const intl = useIntl();
  const { data: allLists } = useSWR<ListSummary[]>('/api/v1/list');
  // Films and series go on watch lists, not playlists.
  const lists = allLists?.filter((list) => list.kind !== 'music');

  // Lists the title is already on, so those come up ticked rather than
  // looking as though it is on none of them.
  const { data: membership } = useSWR<{ listId: number }[]>(
    `/api/v1/list/contains?tmdbId=${tmdbId}&mediaType=${mediaType}`
  );

  const alreadyOn = (membership ?? []).map((entry) => entry.listId);
  const applied = useRef(false);

  useEffect(() => {
    // Apply once, so a tick the user removes does not spring back.
    if (applied.current || !membership) {
      return;
    }

    applied.current = true;

    if (alreadyOn.length) {
      onChange([...new Set([...selected, ...alreadyOn])]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membership]);

  if (!lists?.length) {
    return null;
  }

  const toggle = (id: number) => {
    // Unticking a list it is already on would silently do nothing — removal
    // belongs on the list itself, not in the request dialog.
    if (alreadyOn.includes(id)) {
      return;
    }

    onChange(
      selected.includes(id)
        ? selected.filter((item) => item !== id)
        : [...selected, id]
    );
  };

  return (
    <div className="mt-4 border-t border-gray-700 pt-4">
      <div className="mb-2 flex items-center space-x-2 text-sm font-semibold text-gray-300">
        <BookmarkIcon className="h-4 w-4" />
        <span>{intl.formatMessage(messages.addtolists)}</span>
      </div>
      <ul className="max-h-32 space-y-1 overflow-y-auto">
        {lists.map((list) => (
          <li key={`request-list-${list.id}`}>
            <label className="flex items-center space-x-2 text-sm text-gray-200">
              <input
                checked={selected.includes(list.id)}
                className="h-4 w-4 flex-none rounded border-gray-600 bg-gray-700 text-indigo-600 disabled:opacity-60"
                disabled={alreadyOn.includes(list.id)}
                onChange={() => toggle(list.id)}
                type="checkbox"
              />
              <span className="min-w-0 break-words">{list.name}</span>
              {alreadyOn.includes(list.id) && (
                <span className="flex-none text-xs text-gray-500">
                  {intl.formatMessage(messages.alreadyon)}
                </span>
              )}
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default RequestListPicker;
