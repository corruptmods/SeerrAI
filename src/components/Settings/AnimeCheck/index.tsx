import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import defineMessages from '@app/utils/defineMessages';
import { PlayIcon } from '@heroicons/react/24/outline';
import type { AnimeCheckReport } from '@server/lib/animeCheck';
import type { AnimeDecidedBy } from '@server/lib/animeDecision';
import axios from 'axios';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { FormattedRelativeTime, useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Settings.AnimeCheck', {
  animeCheck: 'Anime Check',
  description:
    'Titles whose place in Sonarr or Radarr disagrees with what Seerr AI says they are: anime if TMDB has its anime keyword (apart from the countries left out above) or it is Japanese animation, unless anime or not was chosen on its request or set on its page. Series are checked for root folder and series type, movies for root folder and quality profile. Nothing is changed here: open a title and use Anime in its manage panel to set it and move it.',
  run: 'Run Check',
  running: 'Checking…',
  runFailed: 'The check could not be started.',
  neverRun: 'Not run yet. It runs daily, or now with Run Check.',
  checkedAt: 'Checked {when}.',
  summary:
    '{server}: {problems, plural, =0 {every one of {checked} series agrees} one {# of {checked} series disagrees} other {# of {checked} series disagree}}.',
  movieSummary:
    '{server}: {problems, plural, =0 {every one of {checked} movies agrees} one {# of {checked} movies disagrees} other {# of {checked} movies disagree}}.',
  unmatched:
    '{count, plural, one {# series is} other {# series are}} not on TMDB, so could not be checked.',
  movieUnmatched:
    '{count, plural, one {# movie is} other {# movies are}} not on TMDB, so could not be checked.',
  foldersNotChecked:
    'Folders are not checked: this server has no anime root folder of its own yet.',
  profilesNotChecked:
    'Profiles are not checked: this server has no anime quality profile of its own yet.',
  moviesNotChecked:
    '{server}: not checked, as this server has no anime root folder or quality profile of its own yet.',
  serverError: '{server} could not be read: {error}',
  isAnime: 'Seerr AI: anime',
  notAnime: 'Seerr AI: not anime',
  chosen: '(chosen for its request)',
  setOnTitle: '(set on its page)',
  wrongType: 'Typed {seriesType} in Sonarr',
  wrongFolder: 'Belongs in {folder}',
  wrongProfile: 'Belongs on {profile}',
  showAll: 'Show all {count}',
});

const SHOWN = 25;

interface Item {
  key: string;
  href: string;
  title: string;
  path: string;
  anime: boolean;
  decidedBy: AnimeDecidedBy;
  badges: { key: string; className: string; text: string }[];
}

const FOLDER = 'bg-indigo-500/20 text-indigo-200';
const OTHER = 'bg-yellow-500/20 text-yellow-200';

const AnimeCheck = () => {
  const intl = useIntl();
  const [problem, setProblem] = useState<string>();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const { data: report, mutate } = useSWR<AnimeCheckReport>(
    '/api/v1/settings/anime-check',
    { refreshInterval: (latest) => (latest?.running ? 3000 : 0) }
  );

  const run = async () => {
    setProblem(undefined);
    try {
      await axios.post('/api/v1/settings/jobs/anime-check/run');
      await mutate();
    } catch {
      setProblem(intl.formatMessage(messages.runFailed));
    }
  };

  const itemList = (group: string, items: Item[]) => {
    const shown = expanded[group] ? items : items.slice(0, SHOWN);
    return (
      <>
        {shown.length > 0 && (
          <ul className="divide-y divide-gray-700 overflow-hidden rounded-md border border-gray-700 bg-gray-800">
            {shown.map((item) => (
              <li key={item.key} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <Link
                    href={item.href}
                    className="font-semibold text-white hover:underline"
                  >
                    {item.title}
                  </Link>
                  <span className="text-xs text-gray-400">
                    {intl.formatMessage(
                      item.anime ? messages.isAnime : messages.notAnime
                    )}
                    {item.decidedBy !== 'detection' &&
                      ` ${intl.formatMessage(
                        item.decidedBy === 'title'
                          ? messages.setOnTitle
                          : messages.chosen
                      )}`}
                  </span>
                </div>
                <div className="break-all text-xs text-gray-500">
                  {item.path}
                </div>
                <div className="mt-1 flex flex-wrap gap-2 text-xs">
                  {item.badges.map((badge) => (
                    <span
                      key={badge.key}
                      className={`rounded px-2 py-0.5 ${badge.className}`}
                    >
                      {badge.text}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
        {!expanded[group] && items.length > SHOWN && (
          <button
            type="button"
            className="text-sm text-indigo-400 hover:text-indigo-300"
            onClick={() => setExpanded({ ...expanded, [group]: true })}
          >
            {intl.formatMessage(messages.showAll, { count: items.length })}
          </button>
        )}
      </>
    );
  };

  const serverBlock = (
    key: string,
    summary: string,
    unmatched: string | null,
    notes: string[],
    list: ReactNode
  ) => (
    <div key={key} className="space-y-3">
      <p className="text-sm text-gray-200">
        {summary}{' '}
        {unmatched && <span className="text-gray-400">{unmatched}</span>}
      </p>
      {notes.map((note) => (
        <p key={note} className="text-sm text-gray-400">
          {note}
        </p>
      ))}
      {list}
    </div>
  );

  const serverError = (key: string, name: string, error: string) => (
    <Alert
      key={key}
      type="warning"
      title={intl.formatMessage(messages.serverError, {
        server: name,
        error,
      })}
    />
  );

  return (
    <>
      <div className="mb-6 mt-10">
        <h3 className="heading">{intl.formatMessage(messages.animeCheck)}</h3>
        <p className="description">
          {intl.formatMessage(messages.description)}
        </p>
      </div>
      <div className="section max-w-6xl space-y-4">
        {problem && <Alert title={problem} type="error" />}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            buttonType="primary"
            buttonSize="sm"
            disabled={!report || report.running}
            onClick={run}
          >
            <PlayIcon />
            <span>
              {intl.formatMessage(
                report?.running ? messages.running : messages.run
              )}
            </span>
          </Button>
          <span className="text-sm text-gray-400">
            {report?.finishedAt
              ? intl.formatMessage(messages.checkedAt, {
                  when: (
                    <FormattedRelativeTime
                      value={Math.round(
                        (Date.parse(report.finishedAt) - Date.now()) / 1000
                      )}
                      updateIntervalInSeconds={60}
                      numeric="auto"
                    />
                  ),
                })
              : report && intl.formatMessage(messages.neverRun)}
          </span>
        </div>

        {report?.servers.map((server) => {
          const key = `sonarr-${server.id}`;
          if (server.error) {
            return serverError(key, server.name, server.error);
          }
          return serverBlock(
            key,
            intl.formatMessage(messages.summary, {
              server: server.name,
              problems: server.problems.length,
              checked: server.seriesChecked,
            }),
            server.unmatched > 0
              ? intl.formatMessage(messages.unmatched, {
                  count: server.unmatched,
                })
              : null,
            server.foldersChecked
              ? []
              : [intl.formatMessage(messages.foldersNotChecked)],
            itemList(
              key,
              server.problems.map((item) => ({
                key: `${key}-${item.sonarrId}`,
                href: `/tv/${item.tmdbId}`,
                title: item.title,
                path: item.path,
                anime: item.anime,
                decidedBy: item.decidedBy,
                badges: [
                  ...(item.wrongType
                    ? [
                        {
                          key: 'type',
                          className: OTHER,
                          text: intl.formatMessage(messages.wrongType, {
                            seriesType: item.seriesType,
                          }),
                        },
                      ]
                    : []),
                  ...(item.wrongFolder && item.expectedFolder
                    ? [
                        {
                          key: 'folder',
                          className: FOLDER,
                          text: intl.formatMessage(messages.wrongFolder, {
                            folder: item.expectedFolder,
                          }),
                        },
                      ]
                    : []),
                ],
              }))
            )
          );
        })}

        {report?.movieServers?.map((server) => {
          const key = `radarr-${server.id}`;
          if (server.error) {
            return serverError(key, server.name, server.error);
          }
          if (!server.foldersChecked && !server.profilesChecked) {
            return (
              <p key={key} className="text-sm text-gray-400">
                {intl.formatMessage(messages.moviesNotChecked, {
                  server: server.name,
                })}
              </p>
            );
          }
          return serverBlock(
            key,
            intl.formatMessage(messages.movieSummary, {
              server: server.name,
              problems: server.problems.length,
              checked: server.moviesChecked,
            }),
            server.unmatched > 0
              ? intl.formatMessage(messages.movieUnmatched, {
                  count: server.unmatched,
                })
              : null,
            [
              ...(server.foldersChecked
                ? []
                : [intl.formatMessage(messages.foldersNotChecked)]),
              ...(server.profilesChecked
                ? []
                : [intl.formatMessage(messages.profilesNotChecked)]),
            ],
            itemList(
              key,
              server.problems.map((item) => ({
                key: `${key}-${item.radarrId}`,
                href: `/movie/${item.tmdbId}`,
                title: item.title,
                path: item.path,
                anime: item.anime,
                decidedBy: item.decidedBy,
                badges: [
                  ...(item.wrongFolder && item.expectedFolder
                    ? [
                        {
                          key: 'folder',
                          className: FOLDER,
                          text: intl.formatMessage(messages.wrongFolder, {
                            folder: item.expectedFolder,
                          }),
                        },
                      ]
                    : []),
                  ...(item.wrongProfile && item.expectedProfile
                    ? [
                        {
                          key: 'profile',
                          className: OTHER,
                          text: intl.formatMessage(messages.wrongProfile, {
                            profile: item.expectedProfile,
                          }),
                        },
                      ]
                    : []),
                ],
              }))
            )
          );
        })}
      </div>
    </>
  );
};

export default AnimeCheck;
