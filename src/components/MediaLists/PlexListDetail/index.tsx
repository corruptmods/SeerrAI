import Button from '@app/components/Common/Button';
import Header from '@app/components/Common/Header';
import { PosterGridSkeleton } from '@app/components/Common/PageSkeleton';
import PageTitle from '@app/components/Common/PageTitle';
import type { PlexListPrivacy } from '@app/components/MediaLists/PlexLists';
import {
  detailOf,
  messages as plexMessages,
} from '@app/components/MediaLists/PlexLists';
import TmdbTitleCard from '@app/components/TitleCard/TmdbTitleCard';
import useToasts from '@app/hooks/useToasts';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowTopRightOnSquareIcon,
  DocumentDuplicateIcon,
} from '@heroicons/react/24/outline';
import axios from 'axios';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.MediaLists.PlexListDetail', {
  copy: 'Copy to a Seerr AI List',
  copied:
    'Copied {added} {added, plural, one {title} other {titles}} to a new list.',
  copiedunmatched:
    'Copied {added} {added, plural, one {title} other {titles}} to a new list. {unmatched} could not be matched.',
  copyfailed: 'Could not copy the list: {detail}',
  openinplex: 'Open in Plex',
  autorequest: 'Request titles added to this list on Plex',
  autorequesttip:
    'What’s on it now is left alone; titles added later are requested for you, within your request limits.',
  autorequestfailed: 'Could not change auto-request: {detail}',
  unmatched:
    '{count} {count, plural, one {title} other {titles}} on this list could not be matched, so {count, plural, one {it isn’t} other {they aren’t}} shown.',
  truncated: 'Only the first 2,000 titles are shown.',
  empty: 'This list is empty. Add titles with Add to List on any title.',
  autorequestproblem: 'The last check for new titles failed: {problem}',
  loadfailed: 'This Plex list could not be read: {detail}',
  rank: 'Number {rank}',
});

interface PlexListItem {
  plexId: string;
  title: string;
  year?: number;
  tmdbId?: number;
  mediaType?: 'movie' | 'tv';
}

interface PlexListResponse {
  id: string;
  owner: string;
  slug: string;
  title: string;
  description?: string;
  ranked: boolean;
  privacy?: PlexListPrivacy;
  truncated: boolean;
  autoRequest: boolean;
  autoRequestProblem?: string;
  canAutoRequest: boolean;
  items: PlexListItem[];
}

/** One of the person's Plex lists: its titles, copying, auto-request. */
const PlexListDetail = () => {
  const intl = useIntl();
  const router = useRouter();
  const { addToast } = useToasts();
  const owner = String(router.query.owner ?? '');
  const slug = String(router.query.slug ?? '');
  const [isCopying, setCopying] = useState(false);
  const [isSaving, setSaving] = useState(false);
  const key =
    owner && slug
      ? `/api/v1/list/plex/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`
      : null;
  const { data, error, mutate } = useSWR<PlexListResponse>(key);

  if (!data && !error) {
    return <PosterGridSkeleton />;
  }
  if (!data) {
    const status = axios.isAxiosError(error) ? error.response?.status : 500;
    if (status === 404) {
      return <ErrorPage statusCode={404} />;
    }
    // Plex refused the sign-in, or couldn't be read: say which.
    return (
      <>
        <PageTitle title={intl.formatMessage(plexMessages.plexLists)} />
        <Header>{intl.formatMessage(plexMessages.plexLists)}</Header>
        <p className="mt-4 text-yellow-400 light:text-warning-text">
          {intl.formatMessage(messages.loadfailed, {
            detail: detailOf(error),
          })}
        </p>
      </>
    );
  }

  // A series and a season of it on the list show as the series once.
  const seen = new Set<string>();
  const shown = data.items.filter(
    (item): item is PlexListItem & Required<Pick<PlexListItem, 'tmdbId'>> => {
      if (!item.tmdbId || !item.mediaType) return false;
      const key = `${item.mediaType}:${item.tmdbId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }
  );
  const unmatched = data.items.filter((item) => !item.tmdbId).length;

  const copy = async () => {
    setCopying(true);
    try {
      const { data: copied } = await axios.post<{
        id: number;
        added: number;
        unmatched: number;
      }>(`${key}/copy`);
      addToast(
        intl.formatMessage(
          copied.unmatched ? messages.copiedunmatched : messages.copied,
          { added: copied.added, unmatched: copied.unmatched }
        ),
        { appearance: 'success', autoDismiss: true }
      );
      router.push(`/lists/${copied.id}`);
    } catch (e) {
      addToast(
        intl.formatMessage(messages.copyfailed, { detail: detailOf(e) }),
        { appearance: 'error', autoDismiss: true }
      );
    } finally {
      setCopying(false);
    }
  };

  const toggleAutoRequest = async () => {
    setSaving(true);
    try {
      await axios.put(`${key}/auto-request`, { enabled: !data.autoRequest });
      await mutate();
    } catch (e) {
      addToast(
        intl.formatMessage(messages.autorequestfailed, {
          detail: detailOf(e),
        }),
        { appearance: 'error', autoDismiss: true }
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageTitle title={data.title} />
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Header>{data.title}</Header>
          <p className="mt-1 text-sm text-muted">
            {[
              intl.formatMessage(plexMessages.plexLists),
              data.privacy &&
                intl.formatMessage(plexMessages[`privacy-${data.privacy}`]),
              data.ranked && intl.formatMessage(plexMessages.ranked),
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {data.description && (
            <p className="mt-2 max-w-3xl whitespace-pre-line break-words text-sm text-strong">
              {data.description}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            buttonSize="sm"
            disabled={isCopying || !shown.length}
            onClick={copy}
          >
            <DocumentDuplicateIcon />
            <span>{intl.formatMessage(messages.copy)}</span>
          </Button>
          <Button
            as="a"
            buttonSize="sm"
            href={`https://watch.plex.tv/u/${encodeURIComponent(data.owner)}/lists/${encodeURIComponent(data.slug)}`}
            rel="noreferrer"
            target="_blank"
          >
            <ArrowTopRightOnSquareIcon />
            <span>{intl.formatMessage(messages.openinplex)}</span>
          </Button>
        </div>
      </div>

      {data.canAutoRequest && (
        <div className="mb-4">
          <label className="flex items-center space-x-2 text-xs text-muted sm:text-sm">
            <input
              checked={data.autoRequest}
              className="h-4 w-4 flex-none rounded border-strong bg-field text-indigo-600"
              disabled={isSaving}
              onChange={toggleAutoRequest}
              type="checkbox"
            />
            <span className="leading-none">
              {intl.formatMessage(messages.autorequest)}
            </span>
          </label>
          <p className="ml-6 mt-1 text-xs text-muted">
            {intl.formatMessage(messages.autorequesttip)}
          </p>
          {data.autoRequest && data.autoRequestProblem && (
            <p className="ml-6 mt-1 text-xs text-yellow-400 light:text-warning-text">
              {intl.formatMessage(messages.autorequestproblem, {
                problem: data.autoRequestProblem,
              })}
            </p>
          )}
        </div>
      )}

      {unmatched > 0 && (
        <p className="mb-4 text-xs text-yellow-400 light:text-warning-text sm:text-sm">
          {intl.formatMessage(messages.unmatched, { count: unmatched })}
        </p>
      )}
      {data.truncated && (
        <p className="mb-4 text-xs text-muted sm:text-sm">
          {intl.formatMessage(messages.truncated)}
        </p>
      )}

      {shown.length ? (
        <ul className="cards-vertical">
          {shown.map((item) => {
            const rank = data.items.indexOf(item) + 1;
            return (
              <li className="relative" key={`plex-item-${item.plexId}`}>
                <TmdbTitleCard
                  canExpand
                  id={item.tmdbId}
                  tmdbId={item.tmdbId}
                  type={item.mediaType as 'movie' | 'tv'}
                  mutateParent={() => mutate()}
                />
                {data.ranked && (
                  <span className="pointer-events-none absolute -left-1 -top-1 z-10 flex h-7 min-w-7 items-center justify-center rounded-full bg-indigo-600 px-1.5 text-sm font-bold text-white shadow ring-2 ring-[rgb(var(--media-scrim-raised))]">
                    <span aria-hidden="true">{rank}</span>
                    <span className="sr-only">
                      {intl.formatMessage(messages.rank, { rank })}
                    </span>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-muted">{intl.formatMessage(messages.empty)}</p>
      )}
    </>
  );
};

export default PlexListDetail;
