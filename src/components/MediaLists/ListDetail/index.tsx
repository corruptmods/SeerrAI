import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import Header from '@app/components/Common/Header';
import { PosterGridSkeleton } from '@app/components/Common/PageSkeleton';
import PageTitle from '@app/components/Common/PageTitle';
import ImportListModal from '@app/components/MediaLists/ImportListModal';
import ListItemCard from '@app/components/MediaLists/ListItemCard';
import Roulette from '@app/components/MediaLists/Roulette';
import ShareListModal from '@app/components/MediaLists/ShareListModal';
import type { ListItem, SeriesProgress } from '@app/hooks/useListDetail';
import { useListDetail } from '@app/hooks/useListDetail';
import useToasts from '@app/hooks/useToasts';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import type { ListSort } from '@app/utils/listSort';
import {
  DEFAULT_LIST_SORT,
  LIST_SORTS,
  isListSort,
  sortListItems,
} from '@app/utils/listSort';
import {
  ArrowRightStartOnRectangleIcon,
  ArrowUpTrayIcon,
  BarsArrowDownIcon,
  PencilIcon,
  SparklesIcon,
  TrashIcon,
  UsersIcon,
} from '@heroicons/react/24/outline';
import axios from 'axios';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.MediaLists.ListDetail', {
  empty: 'Nothing here yet. Use Add to List on any movie or series.',
  share: 'Share',
  rename: 'Rename',
  import: 'Import',
  save: 'Save',
  cancel: 'Cancel',
  movieroulette: 'Movie Roulette',
  showroulette: 'Show Roulette',
  anyroulette: 'Surprise Me',
  watchedsync:
    'Suggest removing titles once everyone on this list has watched them',
  deletelist: 'Delete List',
  confirmdelete: 'Delete this list? This cannot be undone.',
  sharedby: 'Shared by {name}',
  leavelist: 'Leave List',
  confirmleave: 'Leave this list? It will no longer appear in your lists.',
  markwatched: 'Mark as watched',
  unwatch: 'Mark as unwatched',
  towatch: 'To watch',
  watchedsection: 'Watched',
  notavailable: 'Not Available Yet',
  sortby: 'Sort by',
  'sort-added-desc': 'Recently added',
  'sort-added-asc': 'Oldest added',
  'sort-title': 'Title',
  'sort-release-desc': 'Newest release',
  'sort-release-asc': 'Oldest release',
  actionfailed: 'That did not work: {detail}',
  acceptprompt:
    '{name} shared this list with you. If you accept, what you watch can be used to tell when everyone on it has finished a title, and when someone on it uses Pick for the Room. Leave the list to turn it down.',
  accept: 'Accept',
  cannotcheck:
    'Watch sync cannot see what {names} watched (no account on the media server), so it will not suggest removing anything from this list.',
});

/** The order you last chose, on this device, for every list. */
const SORT_KEY = 'list-sort';

const ListDetail = () => {
  const intl = useIntl();
  const router = useRouter();

  const {
    data,
    error,
    mutate,
    watched,
    unwatched,
    unavailable,
    rouletteCandidates,
  } = useListDetail(router.query.listId as string);

  // Each viewer's own position in the series here, from the server's watch
  // history (Tautulli for Plex, Jellyfin or Emby themselves). Absent
  // entries simply show nothing, so a slow or missing answer costs nothing.
  const { data: progress } = useSWR<Record<number, SeriesProgress>>(
    router.query.listId ? `/api/v1/list/${router.query.listId}/progress` : null
  );

  const [isSharing, setSharing] = useState(false);
  const [isRenaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [isSavingName, setSavingName] = useState(false);
  const [isSavingWatchedSync, setSavingWatchedSync] = useState(false);
  const [isImporting, setImporting] = useState(false);
  const [isAccepting, setAccepting] = useState(false);
  const { addToast } = useToasts();
  const [rouletteType, setRouletteType] = useState<
    'movie' | 'tv' | 'all' | null
  >(null);
  const [sort, setSort] = useState<ListSort>(DEFAULT_LIST_SORT);

  // Read after mounting: the server renders the default order, and storage
  // can be unavailable (private browsing), in which case the default stays.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(SORT_KEY);
      if (isListSort(saved)) {
        setSort(saved);
      }
    } catch {
      // Keep the default.
    }
  }, []);

  const chooseSort = (next: ListSort) => {
    setSort(next);
    try {
      window.localStorage.setItem(SORT_KEY, next);
    } catch {
      // Still sorted for this visit.
    }
  };

  if (!data && !error) {
    return <PosterGridSkeleton />;
  }

  if (!data) {
    // A list that was deleted, or that the viewer was taken off, is a 404.
    return (
      <ErrorPage
        statusCode={
          (axios.isAxiosError(error) && error.response?.status) || 500
        }
      />
    );
  }

  // Says what went wrong, and reloads the list so the page shows what is
  // really saved rather than what was tried.
  const showFailure = (e: unknown) => {
    const detail =
      (axios.isAxiosError(e) && e.response?.data?.message) ||
      (e instanceof Error ? e.message : String(e));

    addToast(intl.formatMessage(messages.actionfailed, { detail }), {
      appearance: 'error',
      autoDismiss: true,
    });
    mutate();
  };

  const toggleWatched = async (item: ListItem) => {
    try {
      await axios.post(`/api/v1/list/${data.id}/item/watched`, {
        tmdbId: item.tmdbId,
        mediaType: item.mediaType,
        watched: !item.watchedAt,
      });
      mutate();
    } catch (e) {
      showFailure(e);
    }
  };

  const removeItem = async (item: ListItem) => {
    try {
      await axios.delete(
        `/api/v1/list/${data.id}/item?tmdbId=${item.tmdbId}&mediaType=${item.mediaType}`
      );
      mutate();
    } catch (e) {
      showFailure(e);
    }
  };

  const renderItem = (item: ListItem) => (
    <ListItemCard
      item={item}
      key={`item-${item.id}`}
      progress={item.mediaType === 'tv' ? progress?.[item.tmdbId] : undefined}
      onRemove={removeItem}
      onToggleWatched={toggleWatched}
    />
  );

  const startRename = () => {
    setDraftName(data.name);
    setRenaming(true);
  };

  // autoFocus is discouraged for accessibility, but focusing a field the user
  // just asked for is the expected behaviour — do it via the ref instead.
  const focusNameInput = (input: HTMLInputElement | null) => {
    if (input && document.activeElement !== input) {
      input.focus();
      input.select();
    }
  };

  const saveName = async () => {
    const name = draftName.trim();

    if (!name || name === data.name) {
      setRenaming(false);
      return;
    }

    setSavingName(true);

    try {
      await axios.put(`/api/v1/list/${data.id}`, { name });
      await mutate();
      setRenaming(false);
    } catch (e) {
      showFailure(e);
    } finally {
      setSavingName(false);
    }
  };

  const toggleWatchedSync = async () => {
    setSavingWatchedSync(true);

    try {
      await axios.put(`/api/v1/list/${data.id}`, {
        watchedSync: !data.watchedSync,
      });
      await mutate();
    } catch (e) {
      showFailure(e);
    } finally {
      setSavingWatchedSync(false);
    }
  };

  const acceptList = async () => {
    setAccepting(true);

    try {
      await axios.post(`/api/v1/list/${data.id}/membership`);
      await mutate();
    } catch (e) {
      showFailure(e);
    } finally {
      setAccepting(false);
    }
  };

  const leaveList = async () => {
    if (!window.confirm(intl.formatMessage(messages.confirmleave))) {
      return;
    }

    try {
      await axios.delete(`/api/v1/list/${data.id}/membership`);
      router.push('/lists');
    } catch (e) {
      showFailure(e);
    }
  };

  const deleteList = async () => {
    if (!window.confirm(intl.formatMessage(messages.confirmdelete))) {
      return;
    }

    try {
      await axios.delete(`/api/v1/list/${data.id}`);
      router.push('/lists');
    } catch (e) {
      showFailure(e);
    }
  };

  return (
    <>
      {isSharing && data.isOwner && (
        <ShareListModal
          listId={data.id}
          listName={data.name}
          initialMembers={data.members}
          ownerId={data.owner.id}
          onComplete={() => {
            setSharing(false);
            mutate();
          }}
        />
      )}
      {isImporting && (
        <ImportListModal
          listId={data.id}
          onClose={() => setImporting(false)}
          onImported={() => mutate()}
        />
      )}
      {rouletteType && (
        <Roulette
          items={rouletteCandidates(rouletteType).map((item) => ({
            tmdbId: item.tmdbId,
            mediaType: item.mediaType,
            title: item.title,
            posterPath: item.posterPath,
          }))}
          onClose={() => setRouletteType(null)}
        />
      )}
      <PageTitle title={data.name} />
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          {isRenaming ? (
            <div className="mt-8 flex items-center space-x-2 md:mb-0">
              <input
                className="min-w-0 flex-1 rounded border-strong bg-field px-3 py-1 text-2xl font-bold leading-7 text-strong sm:text-4xl sm:leading-9"
                disabled={isSavingName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    saveName();
                  }

                  if (e.key === 'Escape') {
                    setRenaming(false);
                  }
                }}
                ref={focusNameInput}
                type="text"
                value={draftName}
              />
              <Button
                buttonType="primary"
                disabled={!draftName.trim() || isSavingName}
                onClick={saveName}
              >
                {intl.formatMessage(messages.save)}
              </Button>
              <Button onClick={() => setRenaming(false)}>
                {intl.formatMessage(messages.cancel)}
              </Button>
            </div>
          ) : (
            <Header>{data.name}</Header>
          )}
          {!data.isOwner && (
            <p className="mt-1 text-sm text-muted">
              {intl.formatMessage(messages.sharedby, {
                name: data.owner.displayName,
              })}
            </p>
          )}
        </div>
        {!data.isOwner && (
          <div className="flex flex-wrap gap-2">
            <Button buttonSize="sm" onClick={leaveList}>
              <ArrowRightStartOnRectangleIcon />
              <span>{intl.formatMessage(messages.leavelist)}</span>
            </Button>
          </div>
        )}
        {data.isOwner && (
          <div className="flex flex-wrap gap-2">
            <Button buttonSize="sm" onClick={startRename}>
              <PencilIcon />
              <span>{intl.formatMessage(messages.rename)}</span>
            </Button>
            <Button buttonSize="sm" onClick={() => setImporting(true)}>
              <ArrowUpTrayIcon />
              <span>{intl.formatMessage(messages.import)}</span>
            </Button>
            <Button buttonSize="sm" onClick={() => setSharing(true)}>
              <UsersIcon />
              <span>{intl.formatMessage(messages.share)}</span>
            </Button>
            <Button buttonSize="sm" buttonType="danger" onClick={deleteList}>
              <TrashIcon />
              <span>{intl.formatMessage(messages.deletelist)}</span>
            </Button>
          </div>
        )}
      </div>

      {!data.isOwner && !data.accepted && (
        <Alert type="info">
          <p>
            {intl.formatMessage(messages.acceptprompt, {
              name: data.owner.displayName,
            })}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              buttonSize="sm"
              buttonType="primary"
              disabled={isAccepting}
              onClick={acceptList}
            >
              {intl.formatMessage(messages.accept)}
            </Button>
            <Button buttonSize="sm" disabled={isAccepting} onClick={leaveList}>
              <ArrowRightStartOnRectangleIcon />
              <span>{intl.formatMessage(messages.leavelist)}</span>
            </Button>
          </div>
        </Alert>
      )}

      {data.items.length > 1 && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            {(
              [
                ['movie', messages.movieroulette],
                ['tv', messages.showroulette],
                ['all', messages.anyroulette],
              ] as const
            ).map(([type, label]) => (
              <Button
                buttonSize="sm"
                disabled={rouletteCandidates(type).length < 2}
                key={`roulette-${type}`}
                onClick={() => setRouletteType(type)}
              >
                <SparklesIcon />
                <span>{intl.formatMessage(label)}</span>
              </Button>
            ))}
          </div>
          <div className="flex">
            <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-surface px-3 text-gray-100">
              <BarsArrowDownIcon className="h-5 w-5" />
            </span>
            <select
              aria-label={intl.formatMessage(messages.sortby)}
              className="rounded-r-only"
              id="listSort"
              name="listSort"
              onChange={(e) => {
                if (isListSort(e.target.value)) {
                  chooseSort(e.target.value);
                }
              }}
              value={sort}
            >
              {LIST_SORTS.map((option) => (
                <option key={option} value={option}>
                  {intl.formatMessage(messages[`sort-${option}`])}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {data.isOwner && (
        <label className="mb-4 flex items-center space-x-2 text-xs text-muted sm:text-sm">
          <input
            checked={!!data.watchedSync}
            className="h-4 w-4 flex-none rounded border-strong bg-field text-indigo-600"
            disabled={isSavingWatchedSync}
            onChange={toggleWatchedSync}
            type="checkbox"
          />
          <span className="leading-none">
            {intl.formatMessage(messages.watchedsync)}
          </span>
        </label>
      )}
      {data.isOwner && data.watchedSync && !!data.cannotCheck?.length && (
        <p className="-mt-2 mb-4 text-xs text-yellow-400 light:text-warning-text sm:text-sm">
          {intl.formatMessage(messages.cannotcheck, {
            names: intl.formatList(
              data.cannotCheck.map((person) => person.displayName),
              { type: 'conjunction' }
            ),
          })}
        </p>
      )}

      {data.items.length ? (
        <>
          {unwatched.length > 0 && (
            <>
              {(watched.length > 0 || unavailable.length > 0) && (
                <h2 className="mb-3 text-lg font-semibold text-gray-200">
                  {intl.formatMessage(messages.towatch)}
                </h2>
              )}
              <ul className="cards-vertical mb-8">
                {sortListItems(unwatched, sort).map((item) => renderItem(item))}
              </ul>
            </>
          )}

          {unavailable.length > 0 && (
            <>
              <h2 className="mb-3 text-lg font-semibold text-gray-200">
                {intl.formatMessage(messages.notavailable)}
              </h2>
              <ul className="cards-vertical mb-8">
                {sortListItems(unavailable, sort).map((item) =>
                  renderItem(item)
                )}
              </ul>
            </>
          )}

          {watched.length > 0 && (
            <>
              <h2 className="mb-3 text-lg font-semibold text-gray-200">
                {intl.formatMessage(messages.watchedsection)}
              </h2>
              <ul className="cards-vertical">
                {sortListItems(watched, sort).map((item) => renderItem(item))}
              </ul>
            </>
          )}
        </>
      ) : (
        <p className="text-muted">{intl.formatMessage(messages.empty)}</p>
      )}
    </>
  );
};

export default ListDetail;
