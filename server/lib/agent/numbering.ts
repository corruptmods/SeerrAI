import { episodeLabel } from '@server/lib/agent/rules';
import { VIDEO_RX } from '@server/lib/backfill/naming';
import {
  GENERIC_EPISODE,
  episodeTitleLikeness,
  episodeTitleOf,
  normalize,
  readEpisodeRelease,
} from '@server/lib/downloadCheck/names';

/*
 * Which library episode a release is, when its name and Sonarr disagree.
 * A series Sonarr numbers by scene numbering (TheXEM) reads every name by
 * the scene's seasons: a library's S08E01 can be scene S06E15, and then a
 * release named S08E01 is read as scene S08E01, another library episode
 * altogether. A name that carries the episode's title says which it is,
 * whichever numbering it uses.
 */

export interface NumberedEpisode {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  title?: string;
  hasFile: boolean;
  sceneSeasonNumber?: number | null;
  sceneEpisodeNumber?: number | null;
}

/** How alike a title must be to be taken as the episode's. */
const SAME_TITLE = 0.75;

/** The first season and episode a name gives: "S08E01", "8x01". */
export const numbersInName = (
  name: string
): { season: number; episode: number } | undefined => {
  const m =
    /(?:^|[\s._-])s(\d{1,3})[\s._-]?e(\d{1,4})(?=$|[\s._-]|e\d)/i.exec(name) ??
    /(?:^|[\s._-])(\d{1,2})x(\d{2,3})(?=$|[\s._-])/i.exec(name);
  return m ? { season: Number(m[1]), episode: Number(m[2]) } : undefined;
};

/**
 * The library episode whose title the name carries, when exactly one is
 * clearly it. Undefined when the name has no episode title, or it fits
 * none (or several) well enough.
 */
export const episodeByTitle = <T extends NumberedEpisode>(
  name: string,
  episodes: T[]
): T | undefined => {
  const said = readEpisodeRelease(name.replace(VIDEO_RX, '')).episodeTitle;
  if (!said) return undefined;
  const named = episodes.filter(
    (ep) => ep.title && !GENERIC_EPISODE.test(normalize(ep.title))
  );
  // The very title first: one that merely holds it is a weaker match.
  const exact = named.filter((ep) => normalize(ep.title ?? '') === said);
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;
  const scored = named
    .map((ep) => ({ ep, score: episodeTitleLikeness(said, ep.title ?? '') }))
    .filter((s) => s.score >= SAME_TITLE)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return undefined;
  if (scored.length > 1 && scored[1].score === scored[0].score) {
    return undefined;
  }
  return scored[0].ep;
};

const NUMBER_WORDS: Record<string, string> = {
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
};

/**
 * A title as names and Sonarr both write it: words only, and a part
 * written one way ("Part Two", "Pt 2", "(2)") the same as another ("2").
 */
const titleKey = (title: string): string =>
  normalize(title)
    .replace(
      /\b(?:part|pt)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/g,
      (_, n: string) => NUMBER_WORDS[n] ?? n
    )
    .trim();

/** Each episode's title key, worked out once. */
const keys = new WeakMap<object, string>();
const keyOf = (ep: NumberedEpisode): string => {
  let key = keys.get(ep);
  if (key === undefined) {
    const title = normalize(ep.title ?? '');
    key = title && !GENERIC_EPISODE.test(title) ? titleKey(title) : '';
    keys.set(ep, key);
  }
  return key;
};

/** The one episode with exactly this title key, if just one has it. */
const onlyWith = <T extends NumberedEpisode>(
  key: string,
  episodes: T[]
): T | undefined => {
  if (!key) return undefined;
  const found = episodes.filter((ep) => keyOf(ep) === key);
  return found.length === 1 ? found[0] : undefined;
};

/**
 * The library episode a numbered name's title is, exactly: the words after
 * its episode number are one episode's very title, and no other's. Used
 * where the title overrules the number, so a title that only shares a
 * word or two with an episode's ("The Reckoning Begins", "Reckoning") is
 * never taken for it.
 */
export const episodeTitled = <T extends NumberedEpisode>(
  name: string,
  episodes: T[]
): T | undefined => {
  const said = readEpisodeRelease(name.replace(VIDEO_RX, '')).episodeTitle;
  return said ? onlyWith(titleKey(said), episodes) : undefined;
};

/** Whether a name's episode title is this episode's, more or less. */
export const titleFits = (name: string, ep: NumberedEpisode): boolean => {
  const said = readEpisodeRelease(name.replace(VIDEO_RX, '')).episodeTitle;
  const own = keyOf(ep);
  return (
    !!said &&
    !!own &&
    (titleKey(said) === own ||
      episodeTitleLikeness(said, ep.title ?? '') >= 0.5)
  );
};

/** Whether an episode has a title of its own to search for it by. */
export const ownTitle = (ep: NumberedEpisode): boolean => {
  const key = keyOf(ep);
  return (
    !!key &&
    (key.split(' ').filter((w) => w.length > 3).length >= 2 || key.length >= 12)
  );
};

/**
 * The library episode a name without any episode number is, by its title
 * alone ("Remote Reach - Beyond the Map", a special named only so). The
 * whole of what follows the show's name, up to the release's tags, must be
 * one episode's very title, and a title of some length: "Day One
 * Interview" is not "Day One".
 */
export const episodeNamedIn = <T extends NumberedEpisode>(
  name: string,
  episodes: T[],
  showNames: string[] = []
): T | undefined => {
  let words = normalize(
    name.replace(VIDEO_RX, '').replace(/^(\s*\[[^\]]*\]\s*)+/, '')
  );
  const show = showNames
    .map(normalize)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .find((n) => words.startsWith(`${n} `));
  if (show) words = words.slice(show.length + 1);
  // A year after the show's name: "Remote Reach (2010) - Beyond the Map".
  words = words.replace(/^(19|20)\d{2} /, '');
  const said = episodeTitleOf(words);
  const found = said ? onlyWith(titleKey(said), episodes) : undefined;
  return found && ownTitle(found) ? found : undefined;
};

/** Whether a series is numbered differently by the scene than by TVDB. */
export const sceneDiffers = (ep: NumberedEpisode): boolean =>
  ep.sceneSeasonNumber != null &&
  ep.sceneEpisodeNumber != null &&
  (ep.sceneSeasonNumber !== ep.seasonNumber ||
    ep.sceneEpisodeNumber !== ep.episodeNumber);

const described = (ep: NumberedEpisode) =>
  `${episodeLabel(ep.seasonNumber, ep.episodeNumber)} "${ep.title ?? ''}" (${
    ep.hasFile ? 'on disk' : 'missing'
  })`;

/**
 * What a release name says it is, against the library: the episode its
 * title is, and whether that is the episode Sonarr maps it to (when it
 * maps it to one). Empty when the name says nothing to add.
 */
export const nameReading = (
  name: string,
  episodes: NumberedEpisode[],
  mapped?: NumberedEpisode
): string => {
  const byTitle = episodeByTitle(name, episodes);
  if (mapped) {
    if (!byTitle) return `Sonarr maps it to ${described(mapped)}`;
    if (byTitle.id === mapped.id) return `is ${described(mapped)}`;
    return `Sonarr maps it to ${described(mapped)}, but its title is library ${described(byTitle)}: go by its title`;
  }
  return byTitle ? `its title is library ${described(byTitle)}` : '';
};

/**
 * What a release found on the indexers is, by its name alone: the library
 * episode its numbers are, the one the scene's numbers would make it (for
 * a series Sonarr numbers that way), and the one its title is. Empty when
 * it says nothing about a single episode.
 */
export const indexerReading = (
  name: string,
  episodes: NumberedEpisode[]
): string => {
  const numbers = numbersInName(name);
  const byTitle = episodeByTitle(name, episodes);
  const byNumber = numbers
    ? episodes.find(
        (ep) =>
          ep.seasonNumber === numbers.season &&
          ep.episodeNumber === numbers.episode
      )
    : undefined;
  const byScene = numbers
    ? episodes.find(
        (ep) =>
          sceneDiffers(ep) &&
          ep.sceneSeasonNumber === numbers.season &&
          ep.sceneEpisodeNumber === numbers.episode
      )
    : undefined;
  if (byTitle) {
    return byNumber && byNumber.id !== byTitle.id
      ? `by its number ${described(byNumber)}, but its title is ${described(byTitle)}: go by its title`
      : `is ${described(byTitle)}`;
  }
  if (byNumber && byScene && byScene.id !== byNumber.id) {
    return `${described(byNumber)}, or by the scene's numbering ${described(byScene)}: check the files' titles`;
  }
  return byNumber ? `is ${described(byNumber)}` : '';
};
