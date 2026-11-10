import Button from '@app/components/Common/Button';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowPathIcon,
  LockClosedIcon,
  PlusIcon,
  QueueListIcon,
} from '@heroicons/react/24/outline';
import axios from 'axios';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

export const messages = defineMessages('components.MediaLists.PlexLists', {
  plexLists: 'Plex Lists',
  none: 'You have no Plex lists yet. Start one here, or in the Plex app.',
  newlist: 'New Plex list name',
  ranked: 'Ranked',
  start: 'Start Plex List',
  startfailed: 'Could not start the Plex list: {detail}',
  failed: 'Your Plex lists could not be read: {detail}',
  itemcount: '{count} {count, plural, one {title} other {titles}}',
  empty: 'Empty',
  autorequest: 'Auto-request on',
  'privacy-ANYONE': 'Anyone',
  'privacy-PLEX': 'Anyone signed into Plex',
  'privacy-FRIENDS_OF_FRIENDS': 'Friends of friends',
  'privacy-FRIENDS': 'Friends only',
  'privacy-PRIVATE': 'Private',
});

export type PlexListPrivacy =
  | 'ANYONE'
  | 'PLEX'
  | 'FRIENDS_OF_FRIENDS'
  | 'FRIENDS'
  | 'PRIVATE';

export interface PlexListSummary {
  id: string;
  owner: string;
  slug: string;
  title: string;
  itemCount?: number;
  privacy?: PlexListPrivacy;
  autoRequest: boolean;
}

export interface PlexListsResponse {
  available: boolean;
  canAutoRequest?: boolean;
  lists: PlexListSummary[];
}

/** Where a Plex list's page is in Seerr AI. */
export const plexListHref = (list: { owner: string; slug: string }) =>
  `/lists/plex/${encodeURIComponent(list.owner)}/${encodeURIComponent(list.slug)}`;

/** The error a request failed with, in words. */
export const detailOf = (e: unknown) =>
  (axios.isAxiosError(e) && e.response?.data?.message) ||
  (e instanceof Error ? e.message : String(e));

/** Plex's lists only reach a fixed size of name. */
export const MAX_PLEX_LIST_NAME = 100;

const PlexListCard = ({ list }: { list: PlexListSummary }) => {
  const intl = useIntl();

  return (
    <Link
      className="group relative block aspect-[16/10] overflow-hidden rounded-xl border border-subtle bg-surface shadow transition duration-200 hover:border-gray-500 hover:shadow-lg"
      href={plexListHref(list)}
    >
      <div className="absolute inset-0 flex items-center justify-center">
        <QueueListIcon className="h-10 w-10 text-gray-600" />
      </div>
      <div className="list-card-gradient absolute inset-0" />
      <div className="absolute inset-x-0 bottom-0 p-4">
        <h3 className="break-words text-lg font-bold text-on-media drop-shadow">
          {list.title}
        </h3>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-300 light:text-on-media/80">
          <span>
            {list.itemCount
              ? intl.formatMessage(messages.itemcount, {
                  count: list.itemCount,
                })
              : intl.formatMessage(messages.empty)}
          </span>
          {list.privacy && (
            <span className="flex items-center space-x-1">
              <LockClosedIcon className="h-3.5 w-3.5" />
              <span>
                {intl.formatMessage(messages[`privacy-${list.privacy}`])}
              </span>
            </span>
          )}
          {list.autoRequest && (
            <span className="flex items-center space-x-1">
              <ArrowPathIcon className="h-3.5 w-3.5" />
              <span>{intl.formatMessage(messages.autorequest)}</span>
            </span>
          )}
        </div>
      </div>
    </Link>
  );
};

/**
 * The Lists page's Plex Lists section: the person's own lists on Plex, and
 * starting a new one. Shown only to people signed in with Plex.
 */
const PlexLists = () => {
  const intl = useIntl();
  const router = useRouter();
  const { addToast } = useToasts();
  const [name, setName] = useState('');
  const [ranked, setRanked] = useState(false);
  const [isStarting, setStarting] = useState(false);
  const { data, error, mutate } =
    useSWR<PlexListsResponse>('/api/v1/list/plex');

  if (!data && !error) {
    return null;
  }
  if (data && !data.available) {
    return null;
  }

  const start = async () => {
    const title = name.trim();
    if (!title || isStarting) {
      return;
    }
    setStarting(true);
    try {
      const { data: list } = await axios.post<PlexListSummary>(
        '/api/v1/list/plex',
        { title, ranked }
      );
      setName('');
      setRanked(false);
      await mutate();
      router.push(plexListHref(list));
    } catch (e) {
      addToast(
        intl.formatMessage(messages.startfailed, { detail: detailOf(e) }),
        { appearance: 'error', autoDismiss: true }
      );
    } finally {
      setStarting(false);
    }
  };

  return (
    <section>
      <h2 className="mb-4 flex items-center gap-2 border-b border-subtle pb-2 text-xl font-bold text-strong">
        <QueueListIcon className="h-5 w-5 text-muted" />
        <span>{intl.formatMessage(messages.plexLists)}</span>
        {data && (
          <span className="text-sm font-normal text-muted">
            {data.lists.length}
          </span>
        )}
      </h2>

      {error ? (
        <p className="mb-4 text-sm text-yellow-400 light:text-warning-text">
          {intl.formatMessage(messages.failed, { detail: detailOf(error) })}
        </p>
      ) : (
        <>
          <div className="mb-4 grid max-w-2xl gap-2 sm:flex">
            <input
              className="h-11 w-full min-w-0 rounded border-strong bg-field px-3 text-strong"
              maxLength={MAX_PLEX_LIST_NAME}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  start();
                }
              }}
              placeholder={intl.formatMessage(messages.newlist)}
              type="text"
              value={name}
            />
            <div className="flex gap-2">
              <label className="flex h-11 flex-none items-center space-x-2 text-sm text-muted">
                <input
                  checked={ranked}
                  className="h-4 w-4 rounded border-strong bg-field text-indigo-600"
                  onChange={(e) => setRanked(e.target.checked)}
                  type="checkbox"
                />
                <span>{intl.formatMessage(messages.ranked)}</span>
              </label>
              <Button
                buttonType="primary"
                className="h-11 flex-1 sm:flex-none"
                disabled={!name.trim() || isStarting}
                onClick={start}
              >
                <PlusIcon />
                <span>{intl.formatMessage(messages.start)}</span>
              </Button>
            </div>
          </div>
          {data?.lists.length ? (
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {data.lists.map((list) => (
                <li key={`plex-list-${list.id}`}>
                  <PlexListCard list={list} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted">{intl.formatMessage(messages.none)}</p>
          )}
        </>
      )}
    </section>
  );
};

export default PlexLists;
