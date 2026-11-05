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
 * Which library episode a release is when its name and Sonarr disagree.
 * Sonarr reads names on a scene-numbered (TheXEM) series by scene seasons:
 * library S08E01 can be scene S06E15, so a release named S08E01 is read as
 * another episode entirely. An episode title in the name settles it in
 * either numbering.
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

/** Minimum likeness for a title to count as the episode's. */
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
 * The library episode whose title the name carries, when exactly one
 * clearly matches; undefined otherwise.
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
  // Exact titles first; one that merely contains it is a weaker match.
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
 * A title key that names and Sonarr share: words only, with a part ("Part
 * Two", "Pt 2", "(2)") written as "2".
 */
const titleKey = (title: string): string =>
  normalize(title)
    .replace(
      /\b(?:part|pt)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/g,
      (_, n: string) => NUMBER_WORDS[n] ?? n
    )
    .trim();

/** Each episode's title key, cached. */
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

/** The only episode with this title key, if exactly one has it. */
const onlyWith = <T extends NumberedEpisode>(
  key: string,
  episodes: T[]
): T | undefined => {
  if (!key) return undefined;
  const found = episodes.filter((ep) => keyOf(ep) === key);
  return found.length === 1 ? found[0] : undefined;
};

/**
 * The one library episode whose exact title follows a numbered name's
 * episode number. Used where the title overrules the number, so a partial
 * match ("The Reckoning Begins", "Reckoning") never counts.
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
 * The library episode an unnumbered name is, by title alone ("Remote Reach
 * - Beyond the Map", a special named only so). Everything after the show's
 * name, up to the tags, must be one episode's exact title, and long enough:
 * "Day One Interview" is not "Day One".
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
 * What a release name is against the library: the episode its title is,
 * and whether Sonarr maps it there. Empty when the name adds nothing.
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
 * What an indexer release is by name alone: the library episode by its
 * numbers, by scene numbers (on a scene-numbered series), and by its title.
 * Empty when it names no single episode.
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
