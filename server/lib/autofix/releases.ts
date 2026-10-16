import type {
  ArrFile,
  ArrHistoryRecord,
  ArrRelease,
} from '@server/lib/autofix/arr';

/*
 * Telling releases apart when one replaces another: which of Sonarr's or
 * Radarr's results may be taken, and whether a result is the very release
 * a file on disk came from.
 */

/** Rejections that only say the file on disk is as good: fine to replace. */
export const ONLY_EXISTING =
  /existing file|equal or higher preference|not an upgrade|cutoff (has been |already )?(met|reached)|already meets cutoff/i;

const rejectionText = (r: string | { reason?: string }) =>
  typeof r === 'string' ? r : (r.reason ?? '');

/**
 * Whether Sonarr or Radarr would take a release, but for a file already
 * being there.
 */
export const acceptedBut = (r: ArrRelease) =>
  r.downloadAllowed !== false &&
  (!r.rejected ||
    (r.rejections ?? []).every((x) => ONLY_EXISTING.test(rejectionText(x))));

export const groupOf = (title?: string | null) =>
  (
    title?.match(/^\s*\[([^\]]+)\]/)?.[1] ??
    title?.match(/-([A-Za-z0-9]+)$/)?.[1] ??
    ''
  ).toLowerCase();

const bare = (title: string) =>
  title
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

export const sameTitle = (a?: string | null, b?: string | null) =>
  !!a && !!b && bare(a) === bare(b);

export const grabbedFrom = (release: ArrRelease) =>
  `${release.title}${release.indexer ? ` from ${release.indexer}` : ''}`;

/**
 * The best other release for one episode or movie: one Sonarr or Radarr
 * would only turn down because a file is already there, for that episode
 * alone (a release holding others too would not import over their files),
 * never the release the current file came from, a different group first.
 */
export const pickReplacement = (
  releases: ArrRelease[],
  current: { title?: string | null; group?: string | null },
  episodeId?: number
): ArrRelease | undefined => {
  const currentGroup = (current.group ?? groupOf(current.title)).toLowerCase();
  const forThisEpisode = (r: ArrRelease) => {
    if (episodeId === undefined) return true;
    const mapped = r.mappedEpisodeInfo ?? [];
    return mapped.length
      ? mapped.length === 1 && mapped[0].id === episodeId
      : !!r.episodeRequested;
  };
  const usable = releases.filter(
    (r) =>
      acceptedBut(r) &&
      !r.fullSeason &&
      forThisEpisode(r) &&
      !sameTitle(r.title, current.title)
  );
  const differs = (r: ArrRelease) =>
    !!currentGroup &&
    (r.releaseGroup ?? groupOf(r.title)).toLowerCase() !== currentGroup;
  return usable.sort(
    (a, b) =>
      Number(differs(b)) - Number(differs(a)) ||
      (b.qualityWeight ?? 0) - (a.qualityWeight ?? 0) ||
      (b.customFormatScore ?? 0) - (a.customFormatScore ?? 0) ||
      (b.seeders ?? 0) - (a.seeders ?? 0)
  )[0];
};

/** Where the file on disk came from: the release's own name, if known. */
export const originOf = (
  file: ArrFile | undefined,
  history: ArrHistoryRecord[]
): string | undefined => {
  const imported = history.find(
    (h) =>
      h.eventType === 'downloadFolderImported' &&
      (!file || String(h.data?.fileId ?? '') === String(file.id))
  );
  const dropped = imported?.data?.droppedPath?.split(/[\\/]/).pop();
  return file?.sceneName || dropped || imported?.sourceTitle || undefined;
};
