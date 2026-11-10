import Button from '@app/components/Common/Button';
import Header from '@app/components/Common/Header';
import { ListCardsSkeleton } from '@app/components/Common/PageSkeleton';
import PageTitle from '@app/components/Common/PageTitle';
import ListCard from '@app/components/MediaLists/ListCard';
import type { PlexListsResponse } from '@app/components/MediaLists/PlexLists';
import PlexLists from '@app/components/MediaLists/PlexLists';
import ShareListModal from '@app/components/MediaLists/ShareListModal';
import useFeature from '@app/hooks/useFeature';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import {
  FilmIcon,
  MusicalNoteIcon,
  PlusIcon,
} from '@heroicons/react/24/outline';
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
  watchLists: 'Watch Lists',
  playlists: 'Playlists',
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
  // Playlists need music set up and on for this person.
  const musicOn = useFeature('music');
  const [kind, setKind] = useState<'watch' | 'music'>('watch');
  const [isCreating, setCreating] = useState(false);
  const [sharing, setSharing] = useState<{ id: number; name: string } | null>(
    null
  );
  const { data: lists, mutate, error } = useSWR<ListSummary[]>('/api/v1/list');
  // Same key as the Plex Lists section: whether it shows.
  const { data: plex } = useSWR<PlexListsResponse>('/api/v1/list/plex');

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
      // Refresh the lists, then offer to share the new one, without navigating.
      await mutate();
      setSharing({ id: data.id, name: data.name });
    } catch (e) {
      // Report failures, or the button appears to do nothing.
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

  const sections = (['watch', 'music'] as const)
    .map((kind) => ({
      kind,
      lists: (lists ?? []).filter((list) => (list.kind ?? 'watch') === kind),
    }))
    .filter((section) => section.lists.length);
  // Headings once there's more than one kind of list to tell apart.
  const showHeadings = sections.length > 1 || !!plex?.available;

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

      {/*
        On a phone the name has its own line, with the kind and Create on the
        next; wider, one line. All the same height.
      */}
      <div className="mb-6 grid max-w-2xl gap-2 sm:flex">
        <input
          className="h-11 w-full min-w-0 rounded border-strong bg-field px-3 text-strong"
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
        <div className="flex gap-2">
          {musicOn && (
            <select
              aria-label={intl.formatMessage(messages.kindLabel)}
              className="h-11 flex-1 py-0 sm:w-auto sm:flex-none"
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
            className="h-11 flex-1 sm:flex-none"
            disabled={!newName.trim() || isCreating}
            onClick={create}
          >
            <PlusIcon />
            <span>{intl.formatMessage(messages.createlist)}</span>
          </Button>
        </div>
      </div>

      <div className="space-y-10">
        {lists?.length ? (
          <div className="space-y-10">
            {sections.map((section) => (
              <section key={section.kind}>
                {showHeadings && (
                  <h2 className="mb-4 flex items-center gap-2 border-b border-subtle pb-2 text-xl font-bold text-strong">
                    {section.kind === 'music' ? (
                      <MusicalNoteIcon className="h-5 w-5 text-muted" />
                    ) : (
                      <FilmIcon className="h-5 w-5 text-muted" />
                    )}
                    <span>
                      {intl.formatMessage(
                        section.kind === 'music'
                          ? messages.playlists
                          : messages.watchLists
                      )}
                    </span>
                    <span className="text-sm font-normal text-muted">
                      {section.lists.length}
                    </span>
                  </h2>
                )}
                <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {section.lists.map((list) => (
                    <li key={`list-${list.id}`}>
                      <ListCard
                        id={list.id}
                        index={lists.indexOf(list)}
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
              </section>
            ))}
          </div>
        ) : (
          <p className="text-muted">
            {intl.formatMessage(musicOn ? messages.empty : messages.emptyWatch)}
          </p>
        )}
        <PlexLists />
      </div>
    </>
  );
};

export default MediaLists;
