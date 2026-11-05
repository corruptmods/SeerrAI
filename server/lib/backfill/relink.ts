import type BackfillSonarr from '@server/lib/backfill/sonarr';
import { commandFinished } from '@server/lib/backfill/sonarr';

/*
 * Relinks an imported multi-episode file (S06E01-02) that Sonarr links to
 * one episode, so Plex shows the others as missing: the file is imported
 * again in place for every episode it holds, then renamed (S06E01-E02).
 *
 * Sonarr treats a manual import of a file already in the series folder as
 * that file: it is neither moved nor deleted, only its record is replaced
 * (ImportApprovedEpisodes, newDownload false). Nothing is downloaded and no
 * other file is touched: every other episode given must have no file.
 */

const pad = (n: number) => String(n).padStart(2, '0');
const label = (season: number, numbers: number[]) =>
  numbers.length > 1
    ? `S${pad(season)}E${pad(numbers[0])}-E${pad(numbers[numbers.length - 1])}`
    : `S${pad(season)}E${pad(numbers[0] ?? 0)}`;

export class RelinkError extends Error {
  public name = 'RelinkError';
}

export interface RelinkResult {
  /** File name before and after. */
  from: string;
  to: string;
  /** Linked episodes, e.g. S06E01-E02. */
  episodes: string;
  fileId: number;
  /** False if already linked to all of them. */
  changed: boolean;
}

const WAIT_MS = 2000;
const MAX_WAIT_MS = 2 * 60_000;

const waitFor = async (
  sonarr: BackfillSonarr,
  id: number,
  what: string,
  sleep: (ms: number) => Promise<void>
) => {
  for (let waited = 0; waited <= MAX_WAIT_MS; waited += WAIT_MS) {
    const command = await sonarr.getCommand(id);
    if (commandFinished(command.status)) {
      if (command.status !== 'completed') {
        throw new RelinkError(
          `Sonarr's ${what} ${command.status}${command.message ? `: ${command.message}` : ''}.`
        );
      }
      return;
    }
    await sleep(WAIT_MS);
  }
  throw new RelinkError(`Sonarr's ${what} did not finish in time.`);
};

export const relinkEpisodeFile = async (
  sonarr: BackfillSonarr,
  seriesId: number,
  season: number,
  numbers: number[],
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms))
): Promise<RelinkResult> => {
  const wanted = [...new Set(numbers)].sort((a, b) => a - b);
  if (wanted.length < 2) {
    throw new RelinkError('Give every episode the file holds: two or more.');
  }
  if (wanted.some((n, i) => i && n !== wanted[i - 1] + 1)) {
    throw new RelinkError(
      `A file holds episodes in a row, not ${wanted.join(', ')}.`
    );
  }
  const range = label(season, wanted);
  const [series, episodes, files] = await Promise.all([
    sonarr.getSeriesDetail(seriesId),
    sonarr.getSeriesEpisodes(seriesId),
    sonarr.getEpisodeFiles(seriesId),
  ]);
  const targets = wanted.map((n) => {
    const episode = episodes.find(
      (e) => e.seasonNumber === season && e.episodeNumber === n
    );
    if (!episode) {
      throw new RelinkError(
        `${label(season, [n])} is not an episode of this series.`
      );
    }
    return episode;
  });
  const fileIds = [
    ...new Set(
      targets.filter((e) => e.episodeFileId).map((e) => e.episodeFileId)
    ),
  ];
  if (!fileIds.length) {
    throw new RelinkError(`None of ${range} has a file to relink.`);
  }
  if (fileIds.length > 1) {
    const own = targets
      .filter((e) => e.episodeFileId && e.episodeFileId !== fileIds[0])
      .map((e) => label(season, [e.episodeNumber]));
    throw new RelinkError(
      `${own.join(', ')} already ${own.length > 1 ? 'have files' : 'has a file'} of ${own.length > 1 ? 'their' : 'its'} own, and files are never replaced here. Relink only episodes that are missing beside the one file.`
    );
  }
  const file = files.find((f) => f.id === fileIds[0]);
  if (!file?.relativePath) {
    throw new RelinkError(`Sonarr has no record of the file for ${range}.`);
  }
  const from = file.relativePath;
  if (targets.every((e) => e.episodeFileId === file.id)) {
    return { from, to: from, episodes: range, fileId: file.id, changed: false };
  }
  const path =
    file.path ?? `${series.path.replace(/[\\/]+$/, '')}/${file.relativePath}`;

  // In place, no download id: Sonarr only replaces the file's record.
  await waitFor(
    sonarr,
    await sonarr.manualImport([
      {
        path,
        seriesId,
        episodeIds: targets.map((e) => e.id),
        quality: file.quality,
        languages: file.languages ?? [],
        releaseGroup: file.releaseGroup,
      },
    ]),
    'import',
    sleep
  );
  const relinked = (await sonarr.getEpisodeFiles(seriesId)).find(
    (f) => f.relativePath === from
  );
  const linkedNow = (await sonarr.getSeriesEpisodes(seriesId)).filter(
    (e) => relinked && e.episodeFileId === relinked.id
  );
  if (!relinked || linkedNow.length !== targets.length) {
    throw new RelinkError(
      `Sonarr did not link the file to ${range}; it is unchanged. Look at it in Sonarr's manual import.`
    );
  }
  await waitFor(
    sonarr,
    await sonarr.renameFiles(seriesId, [relinked.id]),
    'rename',
    sleep
  );
  const renamed = (await sonarr.getEpisodeFiles(seriesId)).find(
    (f) => f.id === relinked.id
  );
  return {
    from,
    to: renamed?.relativePath ?? from,
    episodes: range,
    fileId: relinked.id,
    changed: true,
  };
};
