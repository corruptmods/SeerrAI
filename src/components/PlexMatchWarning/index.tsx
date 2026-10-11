import defineMessages from '@app/utils/defineMessages';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import type { PlexMatchProblem } from '@server/lib/plexMatchCheck';
import { mainId, sameName } from '@server/utils/plexMatch';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.PlexMatchWarning', {
  title: 'Plex’s match needs fixing',
  other:
    'Plex matched the folder “{folder}”, where {server} has {expected}, to {plex}. Until the match is fixed, Seerr AI can show the wrong title as available, and episodes and subtitles can be wrong.',
  otherSameName:
    'Plex matched the folder “{folder}”, where {server} has {expected}, to a different title with the same name ({ids}). Until the match is fixed, Seerr AI can show the wrong title as available, and episodes and subtitles can be wrong.',
  differentId:
    'Plex and {server} have the same title in the folder “{folder}”, but use different entries for it ({ids}), so Seerr AI marks Plex’s entry as in the library rather than this one.',
  unmatched:
    'Plex has not matched the folder “{folder}”, where {server} has {expected}, to any title, so Seerr AI cannot see it in the library.',
  thisOne:
    'Plex matched the folder “{folder}” to this title, but {server} has {expected} there. This title may show as available when it is not.',
  fix: 'In Plex, open it, choose Fix Match and pick {expected}. The nightly Plex Match Check clears this once it agrees.',
  fixById:
    'In Plex, open it, choose Fix Match and search for {search} to find exactly this title. The nightly Plex Match Check clears this once it agrees.',
  fixDifferentId:
    'In Plex, open it, choose Fix Match and search for {search}. If Plex finds nothing, {server}’s entry may be the outdated one. The nightly Plex Match Check clears this once they agree.',
});

const named = (t: { title: string; year?: number }) =>
  t.year ? `${t.title} (${t.year})` : t.title;

const label = (m?: { name: string; id: number }) =>
  m ? `${m.name.toUpperCase()} ${m.id}` : undefined;

/**
 * On a title's page, for admins: the last Plex Match Check found that
 * Plex's match for this title's folder disagrees with Sonarr's or Radarr's.
 */
const PlexMatchWarning = ({
  mediaType,
  tmdbId,
  tvdbId,
  ratingKey,
}: {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  tvdbId?: number | null;
  ratingKey?: string | null;
}) => {
  const intl = useIntl();
  const query = new URLSearchParams({ mediaType, tmdbId: String(tmdbId) });
  if (tvdbId) query.set('tvdbId', String(tvdbId));
  if (ratingKey) query.set('ratingKey', ratingKey);
  const { data } = useSWR<{ problem: PlexMatchProblem | null }>(
    `/api/v1/settings/plex-match-check/title?${query}`
  );
  const problem = data?.problem;
  if (!problem) return null;

  // This page is the title Plex wrongly matched the folder to, rather than
  // the one Sonarr or Radarr has in it.
  const isPlexSide =
    !!ratingKey &&
    problem.plex.ratingKey === ratingKey &&
    problem.expected.tmdbId !== tmdbId &&
    (!tvdbId || problem.expected.tvdbId !== tvdbId);
  const want = mainId(problem.kind, problem.expected);
  const got = mainId(problem.kind, problem.plex);
  const values = {
    folder: problem.folder,
    server: problem.expected.server,
    expected: named(problem.expected),
    plex: named(problem.plex),
    ids: [
      want && `${problem.expected.server}: ${label(want)}`,
      got && `Plex: ${label(got)}`,
    ]
      .filter(Boolean)
      .join(', '),
    search: want ? `${want.name}-${want.id}` : '',
  };
  const text = isPlexSide
    ? messages.thisOne
    : problem.reason === 'unmatched'
      ? messages.unmatched
      : problem.reason === 'differentId'
        ? messages.differentId
        : sameName(problem.plex, problem.expected)
          ? messages.otherSameName
          : messages.other;
  const fix = !want
    ? messages.fix
    : problem.reason === 'differentId'
      ? messages.fixDifferentId
      : messages.fixById;

  return (
    <section className="mb-6 rounded-lg bg-yellow-900/30 p-4 ring-1 ring-yellow-600/60">
      <h3 className="flex items-center gap-2 font-semibold text-yellow-200">
        <ExclamationTriangleIcon className="h-5 w-5 flex-none" />
        {intl.formatMessage(messages.title)}
      </h3>
      <p className="mt-2 text-sm text-yellow-100/90">
        {intl.formatMessage(text, values)}
      </p>
      <p className="mt-2 text-sm text-yellow-100/70">
        {intl.formatMessage(fix, values)}
      </p>
    </section>
  );
};

export default PlexMatchWarning;
