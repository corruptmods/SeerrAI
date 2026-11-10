import type {
  PlexListsResponse,
  PlexListSummary,
} from '@app/components/MediaLists/PlexLists';
import {
  detailOf,
  MAX_PLEX_LIST_NAME,
  messages as plexMessages,
} from '@app/components/MediaLists/PlexLists';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import { PlusIcon } from '@heroicons/react/24/outline';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { useSWRConfig } from 'swr';

const messages = defineMessages('components.AddToList.PlexListPicker', {
  newplexlist: 'New Plex list name',
  start: 'Start Plex list',
  noplexlists: 'No Plex lists yet. Start one below.',
  notonplex: 'Plex does not have this title, so it cannot go on a Plex list.',
  failed: 'Plex list update failed: {detail}',
  unreadable: 'Your Plex lists could not be read: {detail}',
});

interface PlexListPickerProps {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  /** Says whether adding it requested the title, as a list add does. */
  onRequest: (request?: {
    outcome: 'requested' | 'here' | 'asked' | 'failed';
    message?: string;
  }) => void;
}

/**
 * The person's Plex lists in Add to List: ticked when the title is on one,
 * and a name box to start a new Plex list with the title on it. Shown only
 * to people signed in with Plex.
 */
const PlexListPicker = ({
  tmdbId,
  mediaType,
  onRequest,
}: PlexListPickerProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { mutate: globalMutate } = useSWRConfig();
  const [pending, setPending] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [isStarting, setStarting] = useState(false);
  const { data: plex } = useSWR<PlexListsResponse>('/api/v1/list/plex');
  const {
    data: membership,
    error,
    mutate,
  } = useSWR<
    (Pick<PlexListSummary, 'id' | 'owner' | 'slug' | 'title'> & {
      contains: boolean;
    })[]
  >(
    plex?.available
      ? `/api/v1/list/plex/contains?tmdbId=${tmdbId}&mediaType=${mediaType}`
      : null
  );

  if (!plex?.available) {
    return null;
  }

  // The lists and any Plex list page showing, so a change shows there too.
  const refreshPlexLists = () =>
    globalMutate(
      (key) =>
        typeof key === 'string' &&
        (key === '/api/v1/list/plex' ||
          (key.startsWith('/api/v1/list/plex/') &&
            !key.startsWith('/api/v1/list/plex/contains')))
    );

  const listPath = (list: { owner: string; slug: string }) =>
    `/api/v1/list/plex/${encodeURIComponent(list.owner)}/${encodeURIComponent(list.slug)}`;

  const reportError = (e: unknown) => {
    const notOnPlex = axios.isAxiosError(e) && e.response?.status === 422;
    addToast(
      notOnPlex
        ? intl.formatMessage(messages.notonplex)
        : intl.formatMessage(messages.failed, { detail: detailOf(e) }),
      { appearance: 'error', autoDismiss: true }
    );
  };

  const add = async (list: { owner: string; slug: string }) => {
    const { data } = await axios.post<{
      request?: Parameters<PlexListPickerProps['onRequest']>[0];
    }>(`${listPath(list)}/item`, { tmdbId, mediaType });
    onRequest(data.request);
  };

  const toggle = async (list: {
    id: string;
    owner: string;
    slug: string;
    contains: boolean;
  }) => {
    setPending((now) => [...now, list.id]);
    try {
      if (list.contains) {
        await axios.delete(
          `${listPath(list)}/item?tmdbId=${tmdbId}&mediaType=${mediaType}`
        );
      } else {
        await add(list);
      }
      await Promise.all([mutate(), refreshPlexLists()]);
    } catch (e) {
      reportError(e);
    } finally {
      setPending((now) => now.filter((id) => id !== list.id));
    }
  };

  const start = async () => {
    const title = name.trim();
    if (!title || isStarting) {
      return;
    }
    setStarting(true);
    try {
      // Started with the title on it; refused first if Plex doesn't have it.
      const { data } = await axios.post<{
        request?: Parameters<PlexListPickerProps['onRequest']>[0];
      }>('/api/v1/list/plex', { title, tmdbId, mediaType });
      setName('');
      onRequest(data.request);
      await Promise.all([mutate(), refreshPlexLists()]);
    } catch (e) {
      reportError(e);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="mt-2 border-t border-gray-700 pt-2">
      <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-400">
        {intl.formatMessage(plexMessages.plexLists)}
      </p>
      {error ? (
        <p className="px-2 py-2 text-sm text-yellow-400 light:text-warning-text">
          {intl.formatMessage(messages.unreadable, { detail: detailOf(error) })}
        </p>
      ) : !membership ? null : membership.length ? (
        <ul className="max-h-40 space-y-1 overflow-y-auto">
          {membership.map((list) => (
            <li key={`plex-${list.id}`}>
              <button
                className="flex w-full items-center space-x-2 rounded px-2 py-2 text-left text-sm text-gray-200 hover:bg-gray-700 disabled:opacity-50"
                disabled={pending.includes(list.id)}
                onClick={() => toggle(list)}
                type="button"
              >
                <input
                  checked={list.contains}
                  className="h-4 w-4 rounded border-gray-600 bg-gray-700 text-indigo-600"
                  readOnly
                  type="checkbox"
                />
                <span className="min-w-0 flex-1 whitespace-normal break-words">
                  {list.title}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-2 py-2 text-sm text-gray-400">
          {intl.formatMessage(messages.noplexlists)}
        </p>
      )}
      <div className="mt-2 flex items-center space-x-2">
        <input
          className="min-w-0 flex-1 rounded border-gray-600 bg-gray-700 px-2 py-1 text-sm text-white"
          maxLength={MAX_PLEX_LIST_NAME}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              start();
            }
          }}
          placeholder={intl.formatMessage(messages.newplexlist)}
          type="text"
          value={name}
        />
        <button
          aria-label={intl.formatMessage(messages.start)}
          className="rounded bg-indigo-600 p-1.5 text-white hover:bg-indigo-500 disabled:opacity-50"
          disabled={!name.trim() || isStarting}
          onClick={start}
          type="button"
        >
          <PlusIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};

export default PlexListPicker;
