import type { TitleRef } from '@server/lib/agent/tools';
import type { ArrEpisode, ArrHistoryRecord } from '@server/lib/autofix/arr';
import { FixRadarr, FixSonarr } from '@server/lib/autofix/arr';
import {
  GROUP_NAME,
  blockedGroups,
  setGroupBlocked,
} from '@server/lib/blockedGroups';
import { getSettings } from '@server/lib/settings';

/*
 * Changes the admin agent can propose and only an admin can approve: block
 * or unblock a release group, mark a download failed, delete a title's
 * files, move a title to another quality profile. (Replacing files goes
 * through grab with replace: true, also approved first.)
 *
 * A proposal is checked and described when it is made, from what Radarr or
 * Sonarr says then, so the admin sees exactly what will happen; it is
 * checked again when approved, against what they say by then.
 */

export type ChangeKind =
  | 'replace'
  | 'blockGroup'
  | 'unblockGroup'
  | 'markFailed'
  | 'deleteFiles'
  | 'changeProfile';

/** One change, as proposed: what it does, in words, and how to do it. */
export interface ProposedChange {
  kind: ChangeKind;
  /** One line: "Delete the file of Resident Evil (2026)". */
  headline: string;
  /** What exactly happens, line by line. */
  details: string[];
  title?: TitleRef;
  params: Record<string, unknown>;
}

/** What waits for an admin's decision on a run. */
export interface Proposal {
  id: string;
  at: string;
  changes: ProposedChange[];
}

export class ChangeError extends Error {}

const GB = 1024 ** 3;
const size = (bytes?: number) =>
  bytes
    ? `${(bytes / GB).toFixed(bytes < 10 * GB ? 1 : 0)} GB`
    : 'unknown size';
const label = (season: number, episode: number) =>
  `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;

const radarrOf = (title: TitleRef) => {
  const server = getSettings().radarr.find((s) => s.id === title.serverId);
  if (!server) throw new ChangeError('That Radarr server is no longer set up.');
  return FixRadarr.forServer(server);
};

const sonarrOf = (title: TitleRef) => {
  const server = getSettings().sonarr.find((s) => s.id === title.serverId);
  if (!server) throw new ChangeError('That Sonarr server is no longer set up.');
  return FixSonarr.forServer(server);
};

/** What deleting does to a file, where Radarr or Sonarr puts deleted ones. */
const whereDeletedGo = async (api: FixRadarr | FixSonarr, app: string) => {
  const bin = await api.extras.recycleBin().catch(() => null);
  return bin
    ? `${app} moves it to its recycle bin (${bin}).`
    : bin === ''
      ? `${app} has no recycle bin, so it is gone for good.`
      : `It goes to ${app}'s recycle bin if one is set; otherwise it is gone for good.`;
};

// ---- describing ------------------------------------------------------------

export interface ChangeInput {
  kind: Exclude<ChangeKind, 'replace'>;
  title?: TitleRef;
  name?: string;
  group?: string;
  season?: number;
  episodes?: number[];
  profile?: string;
  unmonitor?: boolean;
  search?: boolean;
  reason: string;
}

const describeGroup = async (
  input: ChangeInput,
  blocked: boolean
): Promise<ProposedChange> => {
  const group = (input.group ?? '').trim();
  if (!GROUP_NAME.test(group)) {
    throw new ChangeError(
      'Give the release group as it appears in release names, like FLUX.'
    );
  }
  const already = blockedGroups().some(
    (g) => g.toLowerCase() === group.toLowerCase()
  );
  if (blocked && already) throw new ChangeError(`${group} is already blocked.`);
  if (!blocked && !already) throw new ChangeError(`${group} is not blocked.`);
  const details = blocked
    ? [
        `Backfill and the admin agent pass over ${group}'s releases.`,
        `Radarr and Sonarr reject them too: the custom format "Seerr AI: blocked release groups" matches them, and every quality profile scores it too low to accept.`,
        `A file already on disk from ${group} then counts as below the profile, so Radarr or Sonarr takes the next acceptable release as an upgrade, and replaces the file only once that one has imported.`,
      ]
    : [
        `Backfill, the admin agent, Radarr and Sonarr accept ${group}'s releases again.`,
      ];
  return {
    kind: blocked ? 'blockGroup' : 'unblockGroup',
    headline: `${blocked ? 'Block' : 'Unblock'} the release group ${group}`,
    details: [...details, `Why: ${input.reason}`],
    params: { group },
  };
};

/** The newest grab of a title still waiting, or the last one made. */
const lastGrab = (history: ArrHistoryRecord[]) =>
  history.find((h) => h.eventType === 'grabbed');

const describeFailed = async (input: ChangeInput): Promise<ProposedChange> => {
  const title = needTitle(input);
  const name = input.name ?? 'the title';
  if (title.kind === 'movie') {
    const api = radarrOf(title);
    const queued = (await api.getQueue()).filter(
      (q) => (q as { movieId?: number }).movieId === title.arrId
    );
    if (queued.length) {
      return {
        kind: 'markFailed',
        headline: `Mark the download of ${name} failed`,
        title,
        details: [
          ...queued.map(
            (q) =>
              `Removes "${q.title}" from ${q.downloadClient || 'the download client'} with what it downloaded, and blocklists that release.`
          ),
          'Radarr then searches for another.',
          `Why: ${input.reason}`,
        ],
        params: { queueIds: queued.map((q) => q.id) },
      };
    }
    const grab = lastGrab(await api.history(title.arrId));
    if (!grab)
      throw new ChangeError(
        `${name} has nothing downloading and no grab to mark failed.`
      );
    return {
      kind: 'markFailed',
      headline: `Mark the last grab of ${name} failed`,
      title,
      details: [
        `Blocklists "${grab.sourceTitle}", so Radarr never grabs it again, and searches for another.`,
        'The file on disk stays; a release Radarr takes later replaces it only once it has imported.',
        `Why: ${input.reason}`,
      ],
      params: { historyId: grab.id },
    };
  }
  const api = sonarrOf(title);
  const queued = (await api.getQueue()).filter(
    (q) => (q as { seriesId?: number }).seriesId === title.arrId
  );
  if (!queued.length) {
    throw new ChangeError(
      `${name} has nothing downloading in Sonarr to mark failed.`
    );
  }
  return {
    kind: 'markFailed',
    headline: `Mark ${queued.length === 1 ? 'the download' : `${queued.length} downloads`} of ${name} failed`,
    title,
    details: [
      ...queued.map(
        (q) =>
          `Removes "${q.title}" from ${q.downloadClient || 'the download client'} with what it downloaded, and blocklists that release.`
      ),
      'Sonarr then searches for another.',
      `Why: ${input.reason}`,
    ],
    params: { queueIds: [...new Set(queued.map((q) => q.id))] },
  };
};

/** The episodes a change is for: a season, some of its episodes, or all. */
const episodesFor = (all: ArrEpisode[], input: ChangeInput): ArrEpisode[] =>
  all.filter(
    (ep) =>
      (input.season === undefined || ep.seasonNumber === input.season) &&
      (!input.episodes?.length || input.episodes.includes(ep.episodeNumber))
  );

const describeDelete = async (input: ChangeInput): Promise<ProposedChange> => {
  const title = needTitle(input);
  const name = input.name ?? 'the title';
  const unmonitor = !!input.unmonitor;
  if (title.kind === 'movie') {
    const api = radarrOf(title);
    const movie = await api.movieDetail(title.arrId);
    if (!movie.hasFile || !movie.movieFile) {
      throw new ChangeError(`${movie.title} has no file to delete.`);
    }
    return {
      kind: 'deleteFiles',
      headline: `Delete the file of ${movie.title}`,
      title,
      details: [
        `Deletes "${movie.movieFile.relativePath ?? 'its file'}" (${size(movie.movieFile.size)}).`,
        await whereDeletedGo(api, 'Radarr'),
        unmonitor
          ? 'Radarr stops looking for the movie.'
          : movie.monitored === false
            ? 'Radarr is not looking for the movie, so it stays without a file.'
            : 'Radarr still looks for the movie and will download it again.',
        `Why: ${input.reason}`,
      ],
      params: { fileIds: [movie.movieFile.id], unmonitor },
    };
  }
  if (input.season === undefined && input.episodes?.length) {
    throw new ChangeError('Give the season the episodes are in.');
  }
  const api = sonarrOf(title);
  const chosen = episodesFor(await api.episodes(title.arrId), input).filter(
    (ep) => ep.hasFile && ep.episodeFileId
  );
  if (!chosen.length) {
    throw new ChangeError(`${name} has no files there to delete.`);
  }
  const fileIds = [...new Set(chosen.map((ep) => ep.episodeFileId))];
  const files = await Promise.all(fileIds.map((id) => api.episodeFile(id)));
  const bytes = files.reduce((n, f) => n + (f?.size ?? 0), 0);
  const what =
    input.season === undefined
      ? 'every episode'
      : input.episodes?.length
        ? chosen
            .map((ep) => label(ep.seasonNumber, ep.episodeNumber))
            .join(', ')
        : `season ${input.season}`;
  return {
    kind: 'deleteFiles',
    headline: `Delete ${fileIds.length === 1 ? 'the file' : `${fileIds.length} files`} of ${name} (${what})`,
    title,
    details: [
      `Deletes ${fileIds.length === 1 ? 'one file' : `${fileIds.length} files`}, ${size(bytes)}, for ${chosen.length === 1 ? '1 episode' : `${chosen.length} episodes`}${
        files.length <= 4
          ? `: ${files.map((f) => `"${f?.relativePath ?? '?'}"`).join(', ')}`
          : ''
      }.`,
      await whereDeletedGo(api, 'Sonarr'),
      unmonitor
        ? 'Sonarr stops looking for those episodes.'
        : 'Sonarr still looks for those episodes and will download them again.',
      `Why: ${input.reason}`,
    ],
    params: {
      fileIds,
      episodeIds: chosen.map((ep) => ep.id),
      unmonitor,
    },
  };
};

const describeProfile = async (input: ChangeInput): Promise<ProposedChange> => {
  const title = needTitle(input);
  const wanted = (input.profile ?? '').trim().toLowerCase();
  const api = title.kind === 'movie' ? radarrOf(title) : sonarrOf(title);
  const profiles = await api.extras.qualityProfiles();
  const profile = profiles.find((p) => p.name.toLowerCase() === wanted);
  if (!profile) {
    throw new ChangeError(
      `There is no quality profile called "${input.profile}". There are: ${profiles.map((p) => p.name).join(', ')}.`
    );
  }
  const currentId =
    title.kind === 'movie'
      ? (await (api as FixRadarr).movieDetail(title.arrId)).qualityProfileId
      : (await (api as FixSonarr).getSeriesById(title.arrId)).qualityProfileId;
  const current = profiles.find((p) => p.id === currentId);
  if (currentId === profile.id) {
    throw new ChangeError(
      `${input.name ?? 'It'} already uses ${profile.name}.`
    );
  }
  const app = title.kind === 'movie' ? 'Radarr' : 'Sonarr';
  return {
    kind: 'changeProfile',
    headline: `Move ${input.name ?? 'the title'} to the ${profile.name} profile`,
    title,
    details: [
      `${app} moves it from ${current?.name ?? 'its profile'} to ${profile.name}; files already there that ${profile.name} would not choose may be upgraded.`,
      input.search
        ? `${app} then searches for it.`
        : `${app} does not search now; it looks again as usual.`,
      `Why: ${input.reason}`,
    ],
    params: {
      profileId: profile.id,
      profileName: profile.name,
      search: !!input.search,
    },
  };
};

const needTitle = (input: ChangeInput): TitleRef => {
  if (!input.title) throw new ChangeError('Give the title reference.');
  return input.title;
};

/** A change described, or why it cannot be made. */
export const describeChange = (input: ChangeInput): Promise<ProposedChange> => {
  switch (input.kind) {
    case 'blockGroup':
      return describeGroup(input, true);
    case 'unblockGroup':
      return describeGroup(input, false);
    case 'markFailed':
      return describeFailed(input);
    case 'deleteFiles':
      return describeDelete(input);
    case 'changeProfile':
      return describeProfile(input);
  }
};

// ---- applying --------------------------------------------------------------

const ids = (value: unknown): number[] =>
  Array.isArray(value)
    ? value.filter((v): v is number => Number.isInteger(v))
    : [];

/**
 * Makes an approved change (all but replacing, which the agent's grab
 * does), and says what came of it.
 */
export const applyChange = async (change: ProposedChange): Promise<string> => {
  const params = change.params;
  switch (change.kind) {
    case 'blockGroup':
    case 'unblockGroup': {
      const group = String(params.group ?? '');
      const { problems } = await setGroupBlocked(
        group,
        change.kind === 'blockGroup'
      );
      const done = `${change.kind === 'blockGroup' ? 'Blocked' : 'Unblocked'} ${group}.`;
      return problems.length
        ? `${done} Not every server took it: ${problems.join(' ')}`
        : `${done} Radarr and Sonarr are updated.`;
    }
    case 'markFailed': {
      const title = change.title!;
      const api = title.kind === 'movie' ? radarrOf(title) : sonarrOf(title);
      const queueIds = ids(params.queueIds);
      if (queueIds.length) {
        const still = new Set((await api.getQueue()).map((q) => q.id));
        const gone = queueIds.filter((id) => !still.has(id));
        const left = queueIds.filter((id) => still.has(id));
        if (!left.length) {
          return 'Nothing was marked: it had already left the queue (finished, or removed).';
        }
        for (const id of left) await api.extras.removeFromQueue(id);
        return `Marked failed and blocklisted ${left.length === 1 ? 'the download' : `${left.length} downloads`}${
          gone.length ? `; ${gone.length} had already left the queue` : ''
        }. ${title.kind === 'movie' ? 'Radarr' : 'Sonarr'} searches for another.`;
      }
      const historyId = Number(params.historyId);
      if (!Number.isInteger(historyId))
        throw new ChangeError('Nothing to mark failed.');
      await api.extras.markFailed(historyId);
      return 'Marked the grab failed: its release is blocklisted, and Radarr searches for another.';
    }
    case 'deleteFiles': {
      const title = change.title!;
      const fileIds = ids(params.fileIds);
      if (title.kind === 'movie') {
        const api = radarrOf(title);
        const movie = await api.movieDetail(title.arrId);
        // Only the file that was shown: a new one since is not deleted.
        if (!movie.movieFile || !fileIds.includes(movie.movieFile.id)) {
          throw new ChangeError(
            'The file has changed since this was proposed; nothing was deleted.'
          );
        }
        await api.deleteMovieFile(movie.movieFile.id);
        if (params.unmonitor) await api.setMonitored(title.arrId, false);
        return `Deleted the file of ${movie.title}${params.unmonitor ? ', and Radarr stopped looking for it' : ''}.`;
      }
      const api = sonarrOf(title);
      const episodeIds = ids(params.episodeIds);
      const current = new Set(
        (await api.episodes(title.arrId))
          .filter((ep) => episodeIds.includes(ep.id) && ep.hasFile)
          .map((ep) => ep.episodeFileId)
      );
      const deletable = fileIds.filter((id) => current.has(id));
      for (const id of deletable) await api.deleteEpisodeFile(id);
      if (params.unmonitor) await api.setEpisodeMonitoring(episodeIds, false);
      return `Deleted ${deletable.length} file${deletable.length === 1 ? '' : 's'}${
        deletable.length < fileIds.length
          ? ` (${fileIds.length - deletable.length} had changed since and ${
              fileIds.length - deletable.length === 1 ? 'was' : 'were'
            } left alone)`
          : ''
      }${params.unmonitor ? ', and Sonarr stopped looking for those episodes' : ''}.`;
    }
    case 'changeProfile': {
      const title = change.title!;
      const profileId = Number(params.profileId);
      if (title.kind === 'movie') {
        const api = radarrOf(title);
        await api.editMovie(title.arrId, { qualityProfileId: profileId });
        if (params.search) await api.searchMovie(title.arrId);
      } else {
        const api = sonarrOf(title);
        await api.editSeries(title.arrId, { qualityProfileId: profileId });
        if (params.search) {
          // Every monitored episode, with a file or not: the new profile may
          // want better than what is there.
          const wanted = (await api.episodes(title.arrId)).filter(
            (ep) => ep.monitored && ep.seasonNumber > 0
          );
          if (wanted.length) {
            await api.searchEpisodes(wanted.map((ep) => ep.id));
          }
        }
      }
      return `Moved it to ${String(params.profileName)}${params.search ? ' and started a search' : ''}.`;
    }
    case 'replace':
      throw new ChangeError('Replacing is done by the agent’s grab.');
  }
};
