import defineMessages from '@app/utils/defineMessages';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import type { PlexMatchProblem } from '@server/lib/plexMatchCheck';
import {
  comparedIds,
  fileLooksWrong,
  fileMisnamed,
  fixSearch,
  idLabel,
  sameName,
} from '@server/utils/plexMatch';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.PlexMatchWarning', {
  title: '{mediaServer}’s match needs fixing',
  fileTitle: '{server}’s file may be the wrong film',
  other:
    '{mediaServer} matched “{folder}” to {plex}, but {server} has {expected} there. Until fixed, the wrong title may show as available.',
  otherSameName:
    '{mediaServer} matched “{folder}” to a different title with the same name ({ids}), but {server} has {expected} there. Until fixed, the wrong title may show as available.',
  differentId:
    '{mediaServer} and {server} use different entries for “{folder}” ({ids}), so {mediaServer}’s shows as available, not this one.',
  unmatched:
    '{mediaServer} hasn’t matched “{folder}”, where {server} has {expected}, so it isn’t seen as in the library.',
  thisOne:
    '{mediaServer} matched “{folder}” to this title, but {server} has {expected} there, so it may wrongly show as available.',
  fix: 'In Plex, choose Fix Match and pick {expected}. This clears after the next Match Check.',
  fixById:
    'In Plex, choose Fix Match and search for {search}. This clears after the next Match Check.',
  fixDifferentId:
    'In Plex, choose Fix Match and search for {search}. If nothing’s found, {server}’s entry may be outdated.',
  identify:
    'In {mediaServer}, choose Identify and pick {expected}. This clears after the next Match Check.',
  identifyById:
    'In {mediaServer}, choose Identify and enter {idName} id {id}. This clears after the next Match Check.',
  identifyDifferentId:
    'In {mediaServer}, choose Identify and enter {idName} id {id}. If nothing’s found, {server}’s entry may be outdated.',
  fixByIdAlt:
    'In Plex, choose Fix Match and search for {search} or {alt}. This clears after the next Match Check.',
  identifyByIdAlt:
    'In {mediaServer}, choose Identify and enter {idName} id {id} or IMDb id {alt}. This clears after the next Match Check.',
  fileWrong:
    '{server}’s file may not be {expected}: it runs {file} min, the movie {film} min. Replace the file in {server}; don’t fix the match.',
  rename:
    'Also rename “{name}” in {server}, or {mediaServer} may mismatch it again.',
});

const named = (t: { title: string; year?: number }) =>
  t.year ? `${t.title} (${t.year})` : t.title;

/** A warning for one server's mismatch. */
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
  // This page is the title the server wrongly matched, not the Sonarr/Radarr
  // one; found by any of the server's ids, not necessarily this page's.
  const isServerSide =
    problem.expected.tmdbId !== tmdbId &&
    (!tvdbId || problem.expected.tvdbId !== tvdbId);
  // The ids that differed, so an IMDb-only server shows it (offered as a second search).
  const { want: shown, got } = comparedIds(
    problem.kind,
    problem.expected,
    problem.matched
  );
  const { want, also } = fixSearch(problem.kind, problem.expected);
  const alt = shown?.name === 'imdb' ? also : undefined;
  const values = {
    folder: problem.folder,
    server: problem.expected.server,
    expected: named(problem.expected),
    plex: named(problem.matched),
    mediaServer,
    idName: want
      ? want.name === 'imdb'
        ? 'IMDb'
        : want.name.toUpperCase()
      : '',
    id: want?.id ?? '',
    ids: [
      shown && `${problem.expected.server}: ${idLabel(shown)}`,
      got && `${mediaServer}: ${idLabel(got)}`,
    ]
      .filter(Boolean)
      .join(', '),
    search: want ? `${want.name}-${want.id}` : '',
    alt: alt ? (mediaServer === 'Plex' ? `${alt.name}-${alt.id}` : alt.id) : '',
    file: problem.expected.fileRuntime ?? '',
    film: problem.expected.runtime ?? '',
    name: problem.expected.file ?? '',
  };
  // A file far off the film's runtime is likely another film; fixing the match would hide that.
  const film = problem.kind === 'movie' && problem.reason !== 'differentId';
  const wrongFile = film && !isServerSide && fileLooksWrong(problem.expected);
  const misnamed = film && !wrongFile && fileMisnamed(problem.expected);
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
  const fix = wrongFile
    ? messages.fileWrong
    : !want
      ? plex
        ? messages.fix
        : messages.identify
      : problem.reason === 'differentId'
        ? plex
          ? messages.fixDifferentId
          : messages.identifyDifferentId
        : alt
          ? plex
            ? messages.fixByIdAlt
            : messages.identifyByIdAlt
          : plex
            ? messages.fixById
            : messages.identifyById;

  return (
    <section className="mb-6 rounded-lg bg-yellow-900/30 p-4 ring-1 ring-yellow-600/60 light:bg-warning-soft/20 light:ring-warning">
      <h3 className="flex items-center gap-2 font-semibold text-yellow-200 light:text-warning-text">
        <ExclamationTriangleIcon className="h-5 w-5 flex-none" />
        {wrongFile
          ? intl.formatMessage(messages.fileTitle, values)
          : intl.formatMessage(messages.title, { mediaServer })}
      </h3>
      <p className="mt-2 text-sm text-yellow-100/90 light:text-warning-text">
        {intl.formatMessage(text, values)}
      </p>
      <p className="mt-2 text-sm text-yellow-100/70 light:text-default">
        {intl.formatMessage(fix, values)}
      </p>
      {misnamed && (
        <p className="mt-2 text-sm text-yellow-100/70 light:text-default">
          {intl.formatMessage(messages.rename, values)}
        </p>
      )}
    </section>
  );
};

/**
 * Admin warning on a title page when the last Match Check found a media
 * server's match disagreeing with Sonarr/Radarr. One warning per server.
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
  /** The media server's id for this title. */
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
