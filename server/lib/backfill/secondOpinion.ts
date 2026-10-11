import type { User } from '@server/entity/User';
import { aiFeatureOn, askAiJson, cacheKey } from '@server/lib/ai';
import type {
  SonarrEpisode,
  SonarrSeriesDetail,
} from '@server/lib/backfill/sonarr';
import { z } from 'zod';

/*
 * A second opinion on the files Backfill could not place: an episode named
 * only by its title, a special, a number in some other numbering. The
 * model only says which episode a name points to. Sonarr still judges the
 * file, every match is shown as the model's, and none is ever approved
 * without an admin seeing it.
 */

export interface UnclearFile {
  index: number;
  name: string;
  problem: string;
}

export interface Opinion {
  index: number;
  episodeIds: number[];
  why: string;
}

export interface OpinionRequest {
  series: SonarrSeriesDetail;
  packTitle: string;
  files: UnclearFile[];
  episodes: SonarrEpisode[];
}

export type SecondOpinion = (req: OpinionRequest) => Promise<Opinion[]>;

/** The most files sent from one pack. */
export const MAX_FILES = 40;
/** Above this, only the stretch of the series the pack is about is sent. */
const MAX_EPISODES = 500;
const DAY = 24 * 60 * 60 * 1000;

const reply = z.object({
  m: z.array(
    z.object({
      f: z.number().int(),
      e: z.array(z.number().int()).max(3),
      w: z.string().max(300).optional().default(''),
    })
  ),
});

const pad = (n: number) => String(n).padStart(2, '0');

const line = (ep: SonarrEpisode, n: number) =>
  [
    `e${n}: S${pad(ep.seasonNumber)}E${pad(ep.episodeNumber)}`,
    ep.absoluteEpisodeNumber !== undefined
      ? `#${ep.absoluteEpisodeNumber}`
      : '',
    ep.title ? `"${ep.title}"` : '',
    ep.airDateUtc ? `(${ep.airDateUtc.slice(0, 4)})` : '',
  ]
    .filter(Boolean)
    .join(' ');

/**
 * The episodes worth listing. A long series is cut down to the seasons the
 * pack's other files point at, with every special, since the files nobody
 * could place are most often specials.
 */
export const episodesFor = (
  episodes: SonarrEpisode[],
  near: { seasons: number[]; absolutes: number[] }
): SonarrEpisode[] => {
  const sorted = [...episodes].sort(
    (a, b) =>
      a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber
  );
  if (sorted.length <= MAX_EPISODES) return sorted;
  if (!near.seasons.length && !near.absolutes.length) {
    return sorted.slice(0, MAX_EPISODES);
  }
  const lo = near.absolutes.length ? Math.min(...near.absolutes) - 30 : 0;
  const hi = near.absolutes.length ? Math.max(...near.absolutes) + 30 : -1;
  const kept = sorted.filter(
    (ep) =>
      ep.seasonNumber === 0 ||
      near.seasons.includes(ep.seasonNumber) ||
      (ep.absoluteEpisodeNumber !== undefined &&
        ep.absoluteEpisodeNumber >= lo &&
        ep.absoluteEpisodeNumber <= hi)
  );
  return kept.slice(0, MAX_EPISODES);
};

/**
 * The model's answer, checked: only files that were asked about, only
 * episodes that were listed, and nothing claimed twice.
 */
export const readOpinions = (
  answer: z.infer<typeof reply>,
  files: UnclearFile[],
  listed: SonarrEpisode[]
): Opinion[] => {
  const seen = new Set<number>();
  const claimed = new Set<number>();
  const out: Opinion[] = [];
  for (const m of answer.m) {
    const file = files[m.f - 1];
    if (!file || seen.has(file.index)) continue;
    seen.add(file.index);
    const eps = [...new Set(m.e)]
      .map((n) => listed[n - 1])
      .filter((ep): ep is SonarrEpisode => !!ep);
    if (!eps.length || eps.length !== new Set(m.e).size) continue;
    if (eps.some((ep) => claimed.has(ep.id))) continue;
    eps.forEach((ep) => claimed.add(ep.id));
    out.push({
      index: file.index,
      episodeIds: eps.map((ep) => ep.id),
      why: m.w.trim().slice(0, 160),
    });
  }
  return out;
};

const SYSTEM =
  'You match video files from a download to episodes of one TV series. ' +
  'For each numbered file, give the episode it holds by its e-number from the list (two or three only for a file that holds several), ' +
  'or an empty list when it is not an episode of this series or the name does not clearly say which one. ' +
  'Match only on clear evidence: the episode title, a special named the same way, or a number that plainly counts in another order. Never guess. ' +
  'Each episode can be claimed by one file. ' +
  'Reply with JSON only: {"m":[{"f":file,"e":[episode],"w":"the evidence, under 15 words"}]}.';

/**
 * The second opinion as the given admin asks for it, or nothing when the
 * feature is off or no model is set up.
 */
export const aiSecondOpinion = (
  user: User | null | undefined
): SecondOpinion | undefined => {
  if (!user || !aiFeatureOn('aiBackfill', user)) return undefined;
  return async ({ series, packTitle, files, episodes }) => {
    const asked = files.slice(0, MAX_FILES);
    if (!asked.length || !episodes.length) return [];
    const prompt = [
      `Series: ${series.title}${series.year ? ` (${series.year})` : ''}${
        series.seriesType === 'anime'
          ? ', anime (# is the absolute number)'
          : ''
      }`,
      `Download: ${packTitle}`,
      '',
      'Episodes:',
      ...episodes.map((ep, i) => line(ep, i + 1)),
      '',
      'Files:',
      ...asked.map((f, i) => `${i + 1}. ${f.name}`),
    ].join('\n');
    const answer = await askAiJson(reply, {
      feature: 'aiBackfill',
      user,
      system: SYSTEM,
      prompt,
      maxTokens: 40 * asked.length + 80,
      cache: { key: cacheKey(prompt), ms: 7 * DAY },
    });
    return readOpinions(answer, asked, episodes);
  };
};
