import type { ProwlarrRelease } from '@server/api/prowlarr';
import type { User } from '@server/entity/User';
import { aiFeatureOn, askAiJson, cacheKey } from '@server/lib/ai';
import { z } from 'zod';

/*
 * A second opinion on where songs may be, when no release is named for
 * their album or single and no pack of the artist's releases has them: of
 * the releases the artist's name finds, the model names those most likely
 * to hold them as the artist recorded them (the album a single is on, a
 * deluxe edition). It only says where to look. A song is still only taken
 * from a file named as it, never another version, as from any release.
 */

/** Releases listed for the model, best shared first. */
const MAX_LISTED = 40;
/** Releases it may name. */
export const MAX_NAMED = 3;
const DAY = 24 * 60 * 60 * 1000;

const reply = z.object({
  d: z.array(z.number().int()).max(10),
  w: z.string().max(300).optional().default(''),
});

const SYSTEM =
  'You help find songs among music downloads. Given an artist, some of their songs and numbered download names, give the numbers of the downloads most likely to hold those songs as the artist recorded them: the album or EP they are on, a deluxe or expanded edition, or a collection of the artist’s own releases. ' +
  'Best first, at most 3. Never a live, acoustic, remix, karaoke, cover or tribute release, nor another artist’s. ' +
  'An empty list when none plainly would: never guess. ' +
  'Reply with JSON only: {"d":[number],"w":"why, under 15 words"}.';

export interface SongSourceQuestion {
  artist: string;
  songs: string[];
  /** The album or single the songs were looked for as. */
  album: string;
  releases: ProwlarrRelease[];
}

export interface SongSourceAnswer {
  releases: ProwlarrRelease[];
  why: string;
}

export type SongSources = (
  question: SongSourceQuestion
) => Promise<SongSourceAnswer>;

/** The releases named: only listed ones, each once, at most three. */
export const readNamed = (
  numbers: number[],
  listed: ProwlarrRelease[]
): ProwlarrRelease[] => {
  const named: ProwlarrRelease[] = [];
  for (const n of numbers) {
    const release = listed[n - 1];
    if (release && !named.includes(release)) named.push(release);
    if (named.length === MAX_NAMED) break;
  }
  return named;
};

/**
 * The second opinion as the given admin asks for it, or nothing when
 * Backfill's second opinion is off or no model is set up.
 */
export const aiSongSources = (
  user: User | null | undefined
): SongSources | undefined => {
  if (!user || !aiFeatureOn('aiBackfill', user)) return undefined;
  return async ({ artist, songs, album, releases }) => {
    const listed = releases.slice(0, MAX_LISTED);
    if (!listed.length || !songs.length) return { releases: [], why: '' };
    const prompt = [
      `Artist: ${artist}`,
      `Songs: ${songs.map((song) => `"${song}"`).join(', ')}`,
      `Released on: ${album}`,
      '',
      'Downloads:',
      ...listed.map(
        (release, i) =>
          `${i + 1}. ${release.title} (${Math.max(1, Math.round(release.size / 1e6))} MB)`
      ),
    ].join('\n');
    const answer = await askAiJson(reply, {
      feature: 'aiBackfill',
      user,
      system: SYSTEM,
      prompt,
      maxTokens: 120,
      cache: { key: cacheKey(prompt), ms: 7 * DAY },
    });
    return {
      releases: readNamed(answer.d, listed),
      why: answer.w.trim().slice(0, 160),
    };
  };
};
