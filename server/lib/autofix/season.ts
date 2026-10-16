import { languageProblem } from '@server/lib/agent/rules';
import type {
  ArrEpisode,
  ArrFile,
  ArrHistoryRecord,
  ArrRelease,
  FixSonarr,
} from '@server/lib/autofix/arr';
import {
  acceptedBut,
  grabbedFrom,
  groupOf,
  originOf,
  pickReplacement,
  sameTitle,
} from '@server/lib/autofix/releases';
import { blockedGroupOf } from '@server/lib/blockedGroups';
import logger from '@server/logger';

/*
 * Replacing every file of a season, for when someone says the whole season
 * is bad. Its files and the releases they came from are noted first; then
 * Sonarr's search for the season is read for a release that is none of
 * those, a season pack Sonarr would take first, otherwise one release per
 * episode. Only once a replacement is grabbed are the old releases marked
 * failed (so Sonarr never takes them again) and the old files removed, so
 * the new ones import: Sonarr refuses a file of the same quality over one
 * already there. Nothing is removed when nothing could be grabbed.
 *
 * Auto-fix uses this for an admin at once, and for anyone else once an
 * admin approves it through the admin agent; the agent's replace_season
 * tool proposes it the same way.
 */

const LABEL = 'Auto-fix';
/** The most episodes searched for one by one when there is no pack. */
const MAX_EPISODE_SEARCHES = 30;
/** Searches for single episodes running at once. */
const SEARCHES_AT_ONCE = 3;

const pad = (n: number) => String(n).padStart(2, '0');
const episodeName = (ep: Pick<ArrEpisode, 'seasonNumber' | 'episodeNumber'>) =>
  `S${pad(ep.seasonNumber)}E${pad(ep.episodeNumber)}`;
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** A release a season's files came from, as Sonarr's history has it. */
interface OldRelease {
  title: string;
  /** Its grab, to mark failed; none for a file imported by hand. */
  historyId?: number;
  guid?: string;
}

/** What replacing one season would do, worked out before anything changes. */
export interface SeasonPlan {
  seriesId: number;
  seasonNumber: number;
  /** The series' name, as Sonarr has it. */
  name: string;
  /** The season's episodes that have a file. */
  episodes: ArrEpisode[];
  /** The releases the files came from: never taken again. */
  old: OldRelease[];
  /** A season pack to take for all of it. */
  pack?: ArrRelease;
  /** Otherwise, one release per episode. */
  singles: { episode: ArrEpisode; release: ArrRelease }[];
  /** Episodes nothing else was found for: their files stay. */
  left: ArrEpisode[];
}

/** What came of replacing a season. */
export interface SeasonOutcome {
  ok: boolean;
  message: string;
  /** The episodes a new release is coming for, their old files gone. */
  episodeIds: number[];
}

/**
 * Notes a season's files and where each came from: the release it was
 * imported from, and that release's grab, which is what marking it failed
 * blocklists.
 */
const oldReleases = (
  episodes: ArrEpisode[],
  files: Map<number, ArrFile | undefined>,
  history: ArrHistoryRecord[]
): OldRelease[] => {
  const found = new Map<string, OldRelease>();
  const add = (release: OldRelease) => {
    const key = release.historyId
      ? `grab:${release.historyId}`
      : `title:${release.title.toLowerCase()}`;
    if (!found.has(key)) found.set(key, release);
  };
  for (const episode of episodes) {
    const file = files.get(episode.episodeFileId);
    const imported = history.find(
      (h) =>
        h.eventType === 'downloadFolderImported' &&
        (String(h.data?.fileId ?? '') === String(episode.episodeFileId) ||
          (!h.data?.fileId && h.episodeId === episode.id))
    );
    const grab = imported?.downloadId
      ? history.find(
          (h) =>
            h.eventType === 'grabbed' && h.downloadId === imported.downloadId
        )
      : undefined;
    const origin = originOf(
      file,
      imported ? [imported] : history.filter((h) => h.episodeId === episode.id)
    );
    if (grab) {
      add({
        title: grab.sourceTitle,
        historyId: grab.id,
        guid: grab.data?.guid ?? undefined,
      });
    }
    if (origin && !(grab && sameTitle(origin, grab.sourceTitle))) {
      add({ title: origin });
    }
  }
  return [...found.values()];
};

/** Whether a release is one of the old ones, by name or by its guid. */
const isOld = (release: ArrRelease, old: OldRelease[]) =>
  old.some(
    (o) =>
      (!!o.guid && o.guid === release.guid) || sameTitle(o.title, release.title)
  );

/**
 * The rules every replacement keeps to, beyond Sonarr's own: not a release
 * the files came from, not from a blocked group, and in English or the
 * series' own language.
 */
const allowed = (release: ArrRelease, old: OldRelease[], original?: string) =>
  !isOld(release, old) &&
  !blockedGroupOf(release.title, release.releaseGroup) &&
  !languageProblem(release.languages, original);

const groupName = (r: ArrRelease) =>
  (r.releaseGroup ?? groupOf(r.title)).toLowerCase();

/** Best first: another group than the old files', then as Sonarr ranks. */
const best = (releases: ArrRelease[], oldGroups: Set<string>) =>
  [...releases].sort(
    (a, b) =>
      Number(!oldGroups.has(groupName(b))) -
        Number(!oldGroups.has(groupName(a))) ||
      (b.qualityWeight ?? 0) - (a.qualityWeight ?? 0) ||
      (b.customFormatScore ?? 0) - (a.customFormatScore ?? 0) ||
      (b.seeders ?? 0) - (a.seeders ?? 0)
  )[0];

/** Runs `work` on each item, a few at a time. */
const fewAtOnce = async <T, R>(
  items: T[],
  work: (item: T) => Promise<R>
): Promise<R[]> => {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(SEARCHES_AT_ONCE, items.length) },
      async () => {
        while (next < items.length) {
          const i = next++;
          out[i] = await work(items[i]);
        }
      }
    )
  );
  return out;
};

/**
 * Works out how a season would be replaced, changing nothing. `prefer` is
 * the season pack chosen earlier (when an admin approves what was
 * proposed): taken again if Sonarr still offers it and it is still allowed.
 */
export const planSeason = async (
  api: FixSonarr,
  seriesId: number,
  seasonNumber: number,
  prefer?: string
): Promise<SeasonPlan | { nothing: string; noFiles?: ArrEpisode[] }> => {
  const [all, facts, history] = await Promise.all([
    api.episodes(seriesId),
    api
      .seriesFacts(seriesId)
      .catch((): { title?: string; originalLanguage?: string } => ({})),
    api.seasonHistory(seriesId, seasonNumber).catch(() => []),
  ]);
  const name = facts.title ?? 'the series';
  const original = facts.originalLanguage;
  const inSeason = all.filter((ep) => ep.seasonNumber === seasonNumber);
  const episodes = inSeason.filter((ep) => ep.hasFile && ep.episodeFileId);
  if (!inSeason.length) {
    return { nothing: `${name} has no season ${seasonNumber} in Sonarr.` };
  }
  if (!episodes.length) {
    return {
      nothing: `Season ${seasonNumber} has no files to replace.`,
      noFiles: inSeason,
    };
  }
  const fileIds = [...new Set(episodes.map((ep) => ep.episodeFileId))];
  const files = new Map(
    await Promise.all(
      fileIds.map(async (id) => [id, await api.episodeFile(id)] as const)
    )
  );
  const old = oldReleases(episodes, files, history);
  const oldGroups = new Set(
    [
      ...[...files.values()].map((f) => f?.releaseGroup ?? ''),
      ...old.map((o) => groupOf(o.title)),
    ]
      .map((g) => g.toLowerCase())
      .filter(Boolean)
  );
  const ids = new Set(episodes.map((ep) => ep.id));
  const found = (await api.seasonReleases(seriesId, seasonNumber)).filter(
    (r) => acceptedBut(r) && allowed(r, old, original)
  );

  // A season pack for this season alone, holding every episode with a file
  // when Sonarr says which it holds.
  const packs = found.filter((r) => {
    if (!r.fullSeason) return false;
    const seasons = r.seasonNumbers ?? [];
    if (seasons.length > 1) return false;
    if (seasons.length === 1 && seasons[0] !== seasonNumber) return false;
    if (
      !seasons.length &&
      r.seasonNumber !== undefined &&
      r.seasonNumber !== seasonNumber
    ) {
      return false;
    }
    const mapped = (r.mappedEpisodeInfo ?? []).map((m) => m.id);
    return !mapped.length || [...ids].every((id) => mapped.includes(id));
  });
  const chosen =
    (prefer && packs.find((r) => sameTitle(r.title, prefer))) ||
    best(packs, oldGroups);
  const base = { seriesId, seasonNumber, name, episodes, old };
  if (chosen) return { ...base, pack: chosen, singles: [], left: [] };

  // No pack: one release per episode, from the season's search first, then
  // each episode's own search.
  const singles: SeasonPlan['singles'] = [];
  const left: ArrEpisode[] = [];
  const searchable: ArrEpisode[] = [];
  const current = (ep: ArrEpisode) => {
    const file = files.get(ep.episodeFileId);
    return {
      title: originOf(
        file,
        history.filter((h) => h.episodeId === ep.id)
      ),
      group: file?.releaseGroup,
    };
  };
  const pick = (ep: ArrEpisode, releases: ArrRelease[]) =>
    pickReplacement(releases, current(ep), ep.id);
  for (const ep of episodes) {
    const release = pick(ep, found);
    if (release) singles.push({ episode: ep, release });
    else searchable.push(ep);
  }
  const searched = await fewAtOnce(
    searchable.slice(0, MAX_EPISODE_SEARCHES),
    async (ep) =>
      pick(
        ep,
        (await api.releases(ep.id).catch(() => [])).filter((r) =>
          allowed(r, old, original)
        )
      )
  );
  searchable.forEach((ep, i) => {
    const release = searched[i];
    if (release) singles.push({ episode: ep, release });
    else left.push(ep);
  });
  if (!singles.length) {
    return {
      nothing: `No other release of season ${seasonNumber} was found, so nothing was removed.`,
    };
  }
  singles.sort((a, b) => a.episode.episodeNumber - b.episode.episodeNumber);
  return { ...base, singles, left };
};

/**
 * The one line an admin is asked to approve: "Replace season 6 of Slow
 * Horses: download <release> and then remove the 5 current files".
 */
export const planHeadline = (plan: SeasonPlan): string => {
  const replaced = plan.pack
    ? plan.episodes
    : plan.singles.map((s) => s.episode);
  const files = new Set(replaced.map((ep) => ep.episodeFileId)).size;
  const download = plan.pack
    ? plan.pack.title
    : plan.singles.length === 1
      ? plan.singles[0].release.title
      : `${plan.singles.length} releases, one per episode`;
  return `Replace season ${plan.seasonNumber} of ${plan.name}: download ${download} and then remove the ${
    files === 1 ? 'current file' : `${files} current files`
  }`;
};

/** What happens, line by line, for an admin deciding on it. */
export const planDetails = (plan: SeasonPlan): string[] => {
  const app = 'Sonarr';
  const lines = plan.pack
    ? [
        `Downloads the season pack "${plan.pack.title}"${plan.pack.indexer ? ` from ${plan.pack.indexer}` : ''} through ${app}.`,
      ]
    : plan.singles
        .slice(0, 12)
        .map(
          (s) =>
            `${episodeName(s.episode)}: downloads "${s.release.title}"${s.release.indexer ? ` from ${s.release.indexer}` : ''}.`
        );
  if (!plan.pack && plan.singles.length > 12) {
    lines.push(`And ${plan.singles.length - 12} more episodes the same way.`);
  }
  if (plan.left.length) {
    lines.push(
      `Nothing else was found for ${plan.left.map(episodeName).join(', ')}, so ${
        plan.left.length === 1 ? 'its file stays' : 'their files stay'
      }.`
    );
  }
  const marked = plan.old.filter((o) => o.historyId);
  lines.push(
    marked.length
      ? `Once it is grabbed, ${app} marks ${marked
          .map((o) => `"${o.title}"`)
          .join(
            ', '
          )} failed, so it is never taken again, and the current files are removed so the new ones import.`
      : 'Once it is grabbed, the current files are removed so the new ones import.',
    'Until the new files import, those episodes cannot be played. If nothing can be grabbed then, nothing is removed.'
  );
  return lines;
};

/**
 * Carries a plan out: grabs first, and only for what was grabbed marks the
 * old releases failed and removes the old files. Episodes left unmonitored
 * are monitored again, so Sonarr keeps wanting them.
 */
export const carryOutSeason = async (
  api: FixSonarr,
  plan: SeasonPlan
): Promise<SeasonOutcome> => {
  const season = `season ${plan.seasonNumber}`;
  let replaced: ArrEpisode[] = [];
  const grabbed: string[] = [];
  const failed: string[] = [];
  if (plan.pack) {
    try {
      await api.grab(plan.pack);
      grabbed.push(grabbedFrom(plan.pack));
      replaced = plan.episodes;
    } catch (e) {
      logger.warn('Could not grab a season pack', {
        label: LABEL,
        seriesId: plan.seriesId,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      return {
        ok: false,
        episodeIds: [],
        message: `Found ${plan.pack.title}, but it could not be grabbed, so nothing was removed.`,
      };
    }
  } else {
    for (const { episode, release } of plan.singles) {
      try {
        await api.grab(release);
        grabbed.push(grabbedFrom(release));
        replaced.push(episode);
      } catch {
        failed.push(episodeName(episode));
      }
    }
    if (!replaced.length) {
      return {
        ok: false,
        episodeIds: [],
        message: `Other releases of ${season} were found, but none could be grabbed, so nothing was removed.`,
      };
    }
  }

  // A file holding several episodes goes only when all of them are coming.
  const coming = new Set(replaced.map((ep) => ep.id));
  const removable = [
    ...new Set(
      replaced
        .filter((ep) =>
          plan.episodes
            .filter((other) => other.episodeFileId === ep.episodeFileId)
            .every((other) => coming.has(other.id))
        )
        .map((ep) => ep.episodeFileId)
    ),
  ];

  let blocklisted = 0;
  for (const old of plan.old) {
    if (!old.historyId) continue;
    try {
      await api.extras.markFailed(old.historyId);
      blocklisted += 1;
    } catch (e) {
      logger.warn('Could not mark an old release failed', {
        label: LABEL,
        seriesId: plan.seriesId,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
  }
  let removed = 0;
  for (const id of removable) {
    try {
      await api.deleteEpisodeFile(id);
      removed += 1;
    } catch (e) {
      logger.warn('Could not remove an old file', {
        label: LABEL,
        seriesId: plan.seriesId,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
  }
  const unmonitored = replaced.filter((ep) => !ep.monitored).map((ep) => ep.id);
  if (unmonitored.length) {
    await api.monitorEpisodes(unmonitored).catch(() => undefined);
  }

  const marked = plan.old.filter((o) => o.historyId).length;
  const what = plan.pack
    ? `grabbed the season pack ${grabbed[0]}`
    : `grabbed ${plural(grabbed.length, 'release')}, one per episode (no season pack was found): ${grabbed
        .slice(0, 6)
        .join(
          '; '
        )}${grabbed.length > 6 ? ` and ${grabbed.length - 6} more` : ''}`;
  const lines = [
    `Replacing ${season} of ${plan.name}: ${what}.`,
    marked
      ? blocklisted === marked
        ? `The old ${marked === 1 ? 'release was' : 'releases were'} marked failed in Sonarr, so ${
            marked === 1 ? 'it is' : 'they are'
          } not taken again, and ${
            removed === 1 ? 'the old file was' : `the ${removed} old files were`
          } removed so the new ones can import.`
        : `${
            removed === 1 ? 'The old file was' : `The ${removed} old files were`
          } removed so the new ones can import, but the old release could not be marked failed in Sonarr.`
      : `${
          removed === 1 ? 'The old file was' : `The ${removed} old files were`
        } removed so the new ones can import.`,
  ];
  if (removed < removable.length) {
    lines.push(
      `${plural(removable.length - removed, 'old file')} could not be removed; Sonarr will not import over ${
        removable.length - removed === 1 ? 'it' : 'them'
      } until an admin does.`
    );
  }
  if (failed.length) {
    lines.push(
      `${failed.join(', ')} could not be grabbed, so ${
        failed.length === 1 ? 'its file stays' : 'their files stay'
      }.`
    );
  }
  if (plan.left.length) {
    lines.push(
      `No other release was found for ${plan.left.map(episodeName).join(', ')}, so ${
        plan.left.length === 1 ? 'its file stays' : 'their files stay'
      }.`
    );
  }
  return { ok: true, message: lines.join(' '), episodeIds: [...coming] };
};
