import Modal from '@app/components/Common/Modal';
import PosterBackground from '@app/components/Common/PosterBackground';
import { useNotice } from '@app/context/NoticeQueue';
import useFeature from '@app/hooks/useFeature';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.MediaLists.WatchSuggestions', {
  title: 'Finished watching?',
  description:
    'Everyone on these lists has watched these. Remove the ones you’re done with.',
  remove: 'Remove selected',
  keep: 'Keep all',
  onlist: 'on {list}',
  failed: 'Could not save your choice: {detail}',
});

interface Suggestion {
  id: number;
  listId: number;
  listName: string;
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  title?: string;
  posterPath?: string | null;
}

const WatchSuggestions = () => {
  const intl = useIntl();
  const { user } = useUser();
  const [selected, setSelected] = useState<number[] | null>(null);
  const [isSaving, setSaving] = useState(false);
  const [isClosed, setClosed] = useState(false);
  const { addToast } = useToasts();

  // Only fetched once a user is present; the request also triggers the
  // throttled watch-history check on the server.
  const on = useFeature('watchSuggestions');
  const { data: suggestions, mutate } = useSWR<Suggestion[]>(
    on && user?.id ? '/api/v1/list/suggestions' : null,
    { revalidateOnFocus: false }
  );

  const myTurn = useNotice(
    'watchSuggestions',
    !on || !user?.id || isClosed
      ? 'hide'
      : suggestions === undefined
        ? 'pending'
        : suggestions.length
          ? 'show'
          : 'hide'
  );

  if (!myTurn || !suggestions?.length) {
    return null;
  }

  // Default to everything ticked: the common case is wanting them all gone.
  const chosen = selected ?? suggestions.map((s) => s.id);

  const resolve = async (action: 'remove' | 'keep') => {
    setSaving(true);

    try {
      for (const suggestion of suggestions) {
        const remove = action === 'remove' && chosen.includes(suggestion.id);

        await axios.post(`/api/v1/list/suggestions/${suggestion.id}`, {
          action: remove ? 'remove' : 'keep',
        });
      }

      await mutate();
      setClosed(true);
    } catch (e) {
      // Some may have been saved before the failure; reloading shows only
      // the ones still waiting, so the dialog can be tried again.
      const detail =
        (axios.isAxiosError(e) && e.response?.data?.message) ||
        (e instanceof Error ? e.message : String(e));

      addToast(intl.formatMessage(messages.failed, { detail }), {
        appearance: 'error',
        autoDismiss: true,
      });
      mutate();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Transition
      as="div"
      enter="transition-opacity duration-300"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition-opacity duration-300"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
      show
    >
      <Modal
        backgroundClickable={false}
        loading={isSaving}
        okButtonType="primary"
        okDisabled={!chosen.length}
        okText={intl.formatMessage(messages.remove)}
        onCancel={() => setClosed(true)}
        onOk={() => resolve('remove')}
        onSecondary={() => resolve('keep')}
        secondaryButtonType="default"
        secondaryText={intl.formatMessage(messages.keep)}
        title={intl.formatMessage(messages.title)}
      >
        <p className="mb-3 text-sm text-gray-300">
          {intl.formatMessage(messages.description)}
        </p>
        <ul className="max-h-72 space-y-2 overflow-y-auto">
          {suggestions.map((suggestion) => (
            <li key={`suggestion-${suggestion.id}`}>
              <label className="flex items-center space-x-3 text-sm text-gray-200">
                <input
                  checked={chosen.includes(suggestion.id)}
                  className="h-4 w-4 rounded border-gray-600 bg-gray-700 text-indigo-600"
                  onChange={() =>
                    setSelected(
                      chosen.includes(suggestion.id)
                        ? chosen.filter((id) => id !== suggestion.id)
                        : [...chosen, suggestion.id]
                    )
                  }
                  type="checkbox"
                />
                {suggestion.posterPath && (
                  <PosterBackground
                    className="h-12 w-8 flex-none rounded bg-cover bg-center"
                    posterPath={suggestion.posterPath}
                    size="w92"
                  />
                )}
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-semibold">
                    {suggestion.title ?? suggestion.tmdbId}
                  </span>{' '}
                  <span className="text-gray-400">
                    {intl.formatMessage(messages.onlist, {
                      list: suggestion.listName,
                    })}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </Modal>
    </Transition>
  );
};

export default WatchSuggestions;
