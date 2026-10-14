import defineMessages from '@app/utils/defineMessages';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import type { PlexMatchProblem } from '@server/lib/plexMatchCheck';
import { mainId, sameName } from '@server/utils/plexMatch';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.PlexMatchWarning', {
  title: '{mediaServer}’s match needs fixing',
  other:
    '{mediaServer} matched the folder “{folder}”, where {server} has {expected}, to {plex}. Until the match is fixed, Seerr AI can show the wrong title as available, and episodes and subtitles can be wrong.',
  otherSameName:
    '{mediaServer} matched the folder “{folder}”, where {server} has {expected}, to a different title with the same name ({ids}). Until the match is fixed, Seerr AI can show the wrong title as available, and episodes and subtitles can be wrong.',
  differentId:
    '{mediaServer} and {server} have the same title in the folder “{folder}”, but use different entries for it ({ids}), so Seerr AI marks {mediaServer}’s entry as in the library rather than this one.',
  unmatched:
    '{mediaServer} has not matched the folder “{folder}”, where {server} has {expected}, to any title, so Seerr AI cannot see it in the library.',
  thisOne:
    '{mediaServer} matched the folder “{folder}” to this title, but {server} has {expected} there. This title may show as available when it is not.',
  fix: 'In Plex, open it, choose Fix Match and pick {expected}. The nightly Match Check clears this once it agrees.',
  fixById:
    'In Plex, open it, choose Fix Match and search for {search} to find exactly this title. The nightly Match Check clears this once it agrees.',
  fixDifferentId:
    'In Plex, open it, choose Fix Match and search for {search}. If Plex finds nothing, {server}’s entry may be the outdated one. The nightly Match Check clears this once they agree.',
  identify:
    'In {mediaServer}, open it, choose Identify and pick {expected}. The nightly Match Check clears this once it agrees.',
  identifyById:
    'In {mediaServer}, open it, choose Identify and enter {idName} id {id} to find exactly this title. The nightly Match Check clears this once it agrees.',
  identifyDifferentId:
    'In {mediaServer}, open it, choose Identify and enter {idName} id {id}. If {mediaServer} finds nothing, {server}’s entry may be the outdated one. The nightly Match Check clears this once they agree.',
});

const named = (t: { title: string; year?: number }) =>
  t.year ? `${t.title} (${t.year})` : t.title;

const label = (m?: { name: string; id: number }) =>
  m ? `${m.name.toUpperCase()} ${m.id}` : undefined;

/** One server's problem with this title, as a warning. */
const MatchProblem = ({
  problem,
  tmdbId,
  tvdbId,
}: {
  problem: PlexMatchProblem;
  tmdbId: number;
  tvdbId?: number | null;
}) => {
  const intl = useIntl();
  const mediaServer = problem.mediaServer ?? 'Plex';
  // This page is the title the server wrongly matched the folder to, rather
  // than the one Sonarr or Radarr has in it. It was found by one of the
  // servers' ids for this title, not necessarily the one this page passed.
  const isServerSide =
    problem.expected.tmdbId !== tmdbId &&
    (!tvdbId || problem.expected.tvdbId !== tvdbId);
  const want = mainId(problem.kind, problem.expected);
  const got = mainId(problem.kind, problem.matched);
  const values = {
    folder: problem.folder,
    server: problem.expected.server,
    expected: named(problem.expected),
    plex: named(problem.matched),
    mediaServer,
    idName: want?.name.toUpperCase() ?? '',
    id: want?.id ?? '',
    ids: [
      want && `${problem.expected.server}: ${label(want)}`,
      got && `${mediaServer}: ${label(got)}`,
    ]
      .filter(Boolean)
      .join(', '),
    search: want ? `${want.name}-${want.id}` : '',
  };
  const text = isServerSide
    ? messages.thisOne
    : problem.reason === 'unmatched'
      ? messages.unmatched
      : problem.reason === 'differentId'
        ? messages.differentId
        : sameName(problem.matched, problem.expected)
          ? messages.otherSameName
          : messages.other;
  const plex = mediaServer === 'Plex';
  const fix = !want
    ? plex
      ? messages.fix
      : messages.identify
    : problem.reason === 'differentId'
      ? plex
        ? messages.fixDifferentId
        : messages.identifyDifferentId
      : plex
        ? messages.fixById
        : messages.identifyById;

  return (
    <section className="mb-6 rounded-lg bg-yellow-900/30 p-4 ring-1 ring-yellow-600/60">
      <h3 className="flex items-center gap-2 font-semibold text-yellow-200">
        <ExclamationTriangleIcon className="h-5 w-5 flex-none" />
        {intl.formatMessage(messages.title, { mediaServer })}
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

/**
 * On a title's page, for admins: the last Match Check found that a media
 * server's match for this title's folder disagrees with Sonarr's or
 * Radarr's. With several servers connected, each one that has it wrong
 * gets its own warning.
 */
const PlexMatchWarning = ({
  mediaType,
  tmdbId,
  tvdbId,
  itemKey,
}: {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  tvdbId?: number | null;
  /** A media server's id for this title. */
  itemKey?: string | null;
}) => {
  const query = new URLSearchParams({ mediaType, tmdbId: String(tmdbId) });
  if (tvdbId) query.set('tvdbId', String(tvdbId));
  if (itemKey) query.set('key', itemKey);
  const { data } = useSWR<{
    problem: PlexMatchProblem | null;
    problems?: PlexMatchProblem[];
  }>(`/api/v1/settings/plex-match-check/title?${query}`);
  const problems = data?.problems ?? (data?.problem ? [data.problem] : []);

  return (
    <>
      {problems.map((problem, index) => (
        <MatchProblem
          key={`${problem.mediaServer ?? 'Plex'}-${index}`}
          problem={problem}
          tmdbId={tmdbId}
          tvdbId={tvdbId}
        />
      ))}
    </>
  );
};

export default PlexMatchWarning;
