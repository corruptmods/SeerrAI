import Button from '@app/components/Common/Button';
import Header from '@app/components/Common/Header';
import { ListCardsSkeleton } from '@app/components/Common/PageSkeleton';
import PageTitle from '@app/components/Common/PageTitle';
import ListCard from '@app/components/MediaLists/ListCard';
import ShareListModal from '@app/components/MediaLists/ShareListModal';
import useFeature from '@app/hooks/useFeature';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { PlusIcon } from '@heroicons/react/24/outline';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.MediaLists', {
  lists: 'Lists',
  createlist: 'Create List',
  newlist: 'New list name',
  kindWatch: 'Watch list',
  kindMusic: 'Playlist',
  kindLabel: 'What it holds',
  empty:
    'You have no lists yet. Create a watch list for films and series, or a playlist for songs.',
  emptyWatch: 'You have no lists yet. Create one to start collecting titles.',
  createfailed: 'Could not create the list: {detail}',
});

interface ListSummary {
  id: number;
  name: string;
  kind?: 'watch' | 'music';
  /** A playlist's album covers. */
  covers?: string[];
  owner: { id: number; displayName: string };
  isOwner: boolean;
  itemCount: number;
  watchedCount?: number;
  memberCount: number;
  previews: { tmdbId: number; posterPath?: string | null }[];
}

const MediaLists = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { user } = useUser();
  const [newName, setNewName] = useState('');
  // Playlists while music is set up and on for this person.
  const musicOn = useFeature('music');
  const [kind, setKind] = useState<'watch' | 'music'>('watch');
  const [isCreating, setCreating] = useState(false);
  const [sharing, setSharing] = useState<{ id: number; name: string } | null>(
    null
  );
  const { data: lists, mutate, error } = useSWR<ListSummary[]>('/api/v1/list');

  const create = async () => {
    const name = newName.trim();

    if (!name) {
      return;
    }

    setCreating(true);

    try {
      const { data } = await axios.post<{ id: number; name: string }>(
        '/api/v1/list',
        { name, kind: musicOn ? kind : 'watch' }
      );
      setNewName('');
      // Show the list straight away rather than waiting on a refetch, then
      // offer to share it. Both happen without a page navigation, so neither
      // waits on a server round trip.
      await mutate();
      setSharing({ id: data.id, name: data.name });
    } catch (e) {
      // Without this the button silently does nothing when the request
      // fails, which is indistinguishable from the click not registering.
      const detail =
        (axios.isAxiosError(e) && e.response?.data?.message) ||
        (e instanceof Error ? e.message : String(e));

      addToast(
        <span>{intl.formatMessage(messages.createfailed, { detail })}</span>,
        {
          appearance: 'error',
          autoDismiss: true,
        }
      );
    } finally {
      setCreating(false);
    }
  };

  if (!lists && !error) {
    return <ListCardsSkeleton />;
  }

  return (
    <>
      {sharing && (
        <ShareListModal
          listId={sharing.id}
          listName={sharing.name}
          ownerId={user?.id}
          onComplete={() => {
            setSharing(null);
            mutate();
          }}
        />
      )}
      <PageTitle title={intl.formatMessage(messages.lists)} />
      <div className="mb-6">
        <Header>{intl.formatMessage(messages.lists)}</Header>
      </div>

      <div className="mb-6 flex max-w-lg items-center space-x-2">
        <input
          className="min-w-0 flex-1 rounded border-strong bg-field px-3 py-2 text-strong"
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              create();
            }
          }}
          placeholder={intl.formatMessage(messages.newlist)}
          type="text"
          value={newName}
        />
        {musicOn && (
          <select
            aria-label={intl.formatMessage(messages.kindLabel)}
            className="w-auto flex-none"
            onChange={(e) =>
              setKind(e.target.value === 'music' ? 'music' : 'watch')
            }
            value={kind}
          >
            <option value="watch">
              {intl.formatMessage(messages.kindWatch)}
            </option>
            <option value="music">
              {intl.formatMessage(messages.kindMusic)}
            </option>
          </select>
        )}
        <Button
          buttonType="primary"
          disabled={!newName.trim() || isCreating}
          onClick={create}
        >
          <PlusIcon />
          <span>{intl.formatMessage(messages.createlist)}</span>
        </Button>
      </div>

      {lists?.length ? (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {lists.map((list, index) => (
            <li key={`list-${list.id}`}>
              <ListCard
                id={list.id}
                index={index}
                isOwner={list.isOwner}
                itemCount={list.itemCount}
                watchedCount={list.watchedCount}
                memberCount={list.memberCount}
                name={list.name}
                owner={list.owner}
                previews={list.previews ?? []}
                kind={list.kind ?? 'watch'}
                covers={list.covers ?? []}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted">
          {intl.formatMessage(musicOn ? messages.empty : messages.emptyWatch)}
        </p>
      )}
    </>
  );
};

export default MediaLists;
