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
 * Whole-season replacement. Notes the files and their source releases, then
 * picks a different release from Sonarr's season search: a pack first, else
 * one per episode. Only after a grab are the old releases marked failed (so
 * Sonarr never retakes them) and the old files removed, since Sonarr won't
 * import same quality over an existing file. Nothing is removed if nothing
 * was grabbed.
 *
 * Runs immediately for admins, else after admin approval via the admin
 * agent; the agent's replace_season tool proposes it the same way.
 */

const LABEL = 'Auto-fix';
/** Max episodes searched individually when there's no pack. */
const MAX_EPISODE_SEARCHES = 30;
/** Concurrent single-episode searches. */
const SEARCHES_AT_ONCE = 3;

const pad = (n: number) => String(n).padStart(2, '0');
const episodeName = (ep: Pick<ArrEpisode, 'seasonNumber' | 'episodeNumber'>) =>
  `S${pad(ep.seasonNumber)}E${pad(ep.episodeNumber)}`;
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** A source release of the season's files, from Sonarr history. */
interface OldRelease {
  title: string;
  /** Its grab, to mark failed; none for a manual import. */
  historyId?: number;
  guid?: string;
}

/** A season replacement plan, computed before any change. */
export interface SeasonPlan {
  seriesId: number;
  seasonNumber: number;
  /** Series name in Sonarr. */
  name: string;
  /** Episodes with a file. */
  episodes: ArrEpisode[];
  /** Source releases of the files; never retaken. */
  old: OldRelease[];
  /** Season pack covering all of it. */
  pack?: ArrRelease;
  /** Otherwise, one release per episode. */
  singles: { episode: ArrEpisode; release: ArrRelease }[];
  /** Episodes with no alternative; their files stay. */
  left: ArrEpisode[];
}

/** A release as Sonarr identifies it for a grab. */
interface ReleaseId {
  guid: string;
  indexerId: number;
}

/** The releases an admin approved: a pack, or one per episode. */
export type ApprovedReleases =
  | { pack: ReleaseId }
  | { singles: (ReleaseId & { episodeId: number })[] };

const idOf = (release: ArrRelease): ReleaseId => ({
  guid: release.guid,
  indexerId: release.indexerId,
});

const isReleaseId = (value: unknown): value is ReleaseId =>
  !!value &&
  typeof (value as ReleaseId).guid === 'string' &&
  Number.isInteger((value as ReleaseId).indexerId);

const sameRelease = (release: ArrRelease, id: ReleaseId) =>
  release.guid === id.guid && release.indexerId === id.indexerId;

/** The releases a plan would grab, to keep with its proposal. */
export const approvedOf = (plan: SeasonPlan): ApprovedReleases =>
  plan.pack
    ? { pack: idOf(plan.pack) }
    : {
        singles: plan.singles.map((s) => ({
          episodeId: s.episode.id,
          ...idOf(s.release),
        })),
      };

/** The approved releases kept with a proposal, if it names them. */
export const approvedFrom = (
  params: Record<string, unknown>
): ApprovedReleases | undefined => {
  const { pack, singles } = params;
  if (isReleaseId(pack)) {
    return { pack: { guid: pack.guid, indexerId: pack.indexerId } };
  }
  const isSingle = (s: unknown): s is ReleaseId & { episodeId: number } =>
    isReleaseId(s) &&
    Number.isInteger((s as { episodeId?: unknown }).episodeId);
  if (Array.isArray(singles) && singles.length && singles.every(isSingle)) {
    return {
      singles: singles.map((s) => ({
        episodeId: s.episodeId,
        guid: s.guid,
        indexerId: s.indexerId,
      })),
    };
  }
  return undefined;
};

const NO_LONGER_OFFERED =
  'The approved release is no longer offered, so nothing was grabbed or removed.';

/** Outcome of a season replacement. */
export interface SeasonOutcome {
  ok: boolean;
  message: string;
  /** Episodes with a new release coming and old files removed. */
  episodeIds: number[];
}

/**
 * Records each file's source release and its grab (marking the grab failed
 * blocklists it).
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

/** Whether a release is one of the old ones, by name or guid. */
const isOld = (release: ArrRelease, old: OldRelease[]) =>
  old.some(
    (o) =>
      (!!o.guid && o.guid === release.guid) || sameTitle(o.title, release.title)
  );

/**
 * Beyond Sonarr's rules: not an old release, not a blocked group, English or
 * the original language.
 */
const allowed = (release: ArrRelease, old: OldRelease[], original?: string) =>
  !isOld(release, old) &&
  !blockedGroupOf(release.title, release.releaseGroup) &&
  !languageProblem(release.languages, original);

const groupName = (r: ArrRelease) =>
  (r.releaseGroup ?? groupOf(r.title)).toLowerCase();

/** Best first: a different group from the old files', then Sonarr's ranking. */
const best = (releases: ArrRelease[], oldGroups: Set<string>) =>
  [...releases].sort(
    (a, b) =>
      Number(!oldGroups.has(groupName(b))) -
        Number(!oldGroups.has(groupName(a))) ||
      (b.qualityWeight ?? 0) - (a.qualityWeight ?? 0) ||
      (b.customFormatScore ?? 0) - (a.customFormatScore ?? 0) ||
      (b.seeders ?? 0) - (a.seeders ?? 0)
  )[0];

/** Runs `work` on each item with limited concurrency. */
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
 * The approved releases, found again in fresh searches by guid and indexer,
 * or undefined if any is gone. Episodes not approved keep their files.
 */
const planApproved = async (
  api: FixSonarr,
  approved: ApprovedReleases,
  base: Pick<
    SeasonPlan,
    'seriesId' | 'seasonNumber' | 'name' | 'episodes' | 'old'
  >,
  packs: ArrRelease[],
  found: ArrRelease[],
  usable: (release: ArrRelease) => boolean
): Promise<SeasonPlan | undefined> => {
  if ('pack' in approved) {
    const pack = packs.find((r) => sameRelease(r, approved.pack));
    return pack ? { ...base, pack, singles: [], left: [] } : undefined;
  }
  const byId = new Map(base.episodes.map((ep) => [ep.id, ep]));
  if (
    !approved.singles.length ||
    approved.singles.some((s) => !byId.has(s.episodeId))
  ) {
    return undefined;
  }
  const releases = await fewAtOnce(
    approved.singles,
    async (s) =>
      found.find((r) => !r.fullSeason && sameRelease(r, s)) ??
      (await api.releases(s.episodeId).catch(() => [])).find(
        (r) => !r.fullSeason && sameRelease(r, s) && acceptedBut(r) && usable(r)
      )
  );
  if (releases.some((r) => !r)) return undefined;
  const singles = approved.singles
    .map((s, i) => ({
      episode: byId.get(s.episodeId) as ArrEpisode,
      release: releases[i] as ArrRelease,
    }))
    .sort((a, b) => a.episode.episodeNumber - b.episode.episodeNumber);
  const coming = new Set(approved.singles.map((s) => s.episodeId));
  return {
    ...base,
    singles,
    left: base.episodes.filter((ep) => !coming.has(ep.id)),
  };
};

/**
 * Plans a season replacement without changing anything. With `approved`
 * (on approval), takes exactly those releases, or nothing if any of them is
 * no longer offered and allowed.
 */
export const planSeason = async (
  api: FixSonarr,
  seriesId: number,
  seasonNumber: number,
  approved?: ApprovedReleases
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

  // A pack for this season only, covering every episode with a file when
  // Sonarr reports its contents.
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
  const base = { seriesId, seasonNumber, name, episodes, old };
  if (approved) {
    return (
      (await planApproved(api, approved, base, packs, found, (r) =>
        allowed(r, old, original)
      )) ?? { nothing: NO_LONGER_OFFERED }
    );
  }
  const chosen = best(packs, oldGroups);
  if (chosen) return { ...base, pack: chosen, singles: [], left: [] };

  // No pack: one release per episode, from the season search, then per-episode
  // searches.
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
 * One-line approval prompt: "Replace season 6 of Harbour Lights: download
 * <release> and then remove the 5 current files".
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

/** Step-by-step details for the approving admin. */
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
    'Until the new files import, those episodes cannot be played. If what is shown here is no longer offered or cannot be grabbed then, nothing is removed.'
  );
  return lines;
};

/**
 * Executes a plan: grabs first, then for what was grabbed marks old releases
 * failed and removes old files. Re-monitors unmonitored episodes so Sonarr
 * keeps wanting them.
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

  // Remove a multi-episode file only if all its episodes are coming.
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
