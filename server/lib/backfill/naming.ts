/*
 * Reading episode numbers out of file names, and building the name Sonarr
 * is asked to judge.
 *
 * Packs often name their files with less than Sonarr needs: Judas's Naruto
 * files are "[Judas] Naruto - S05E17 (202).mkv", with the quality only on
 * the pack, and with the pack's own season split, so Sonarr reads S05E17 as
 * TVDB's episode 196 when the file is episode 202. So each file is renamed
 * for Sonarr: the release group, the series' title as Sonarr knows it, the
 * episode number that is right for the series type, and the pack's quality
 * tags — "[Judas] Naruto - 202 [BD 1080p][HEVC x265 10bit][Multi-Audio]",
 * which Sonarr maps to the right episode and scores like the real release.
 */

export const VIDEO_RX = /\.(mkv|mp4|avi|m4v|ts|wmv|mov|webm)$/i;

/** Files in a pack that are never episodes. */
const EXTRA_RX =
  /(^|[\s._/\-[(])(sample|trailer|ncop\d*|nced\d*|creditless|preview|menu|bonus|extras?|featurettes?|behind[\s._-]the[\s._-]scenes)([\s._/\-\])]|$)/i;

export const QUALITY_TOKEN =
  /\b(480p|576p|720p|1080p|2160p|4k|uhd|bd|bdrip|bluray|blu-ray|bdmv|remux|web|web-?dl|web-?rip|webrip|hdtv|dvd|dvdrip|x264|x265|h\.?264|h\.?265|hevc|avc|av1|10-?bit|8-?bit|hi10p?|aac|ac3|eac3|e-ac-3|dd5\.1|ddp|flac|opus|dts|truehd|dual[\s.-]?audio|multi[\s.-]?audio|multi[\s.-]?subs?|dual|dubbed|subbed|eng|jpn|japanese|english|hdr|dv|cr|nf|amzn|dsnp|hmax|atvp|funi|vrv|hidive|b-global)\b/i;

const PACK_ONLY =
  /\b(complete|batch|season|seasons|series|collection|vol(ume)?|s\d{1,2}\s*-\s*s?\d{1,2}|\d{1,4}\s*[-~]\s*\d{1,4})\b/i;

export const isVideo = (path: string): boolean => VIDEO_RX.test(path);

export const isExtra = (path: string): boolean => EXTRA_RX.test(path);

export const baseName = (path: string): string =>
  (path.split('/').pop() ?? path).replace(VIDEO_RX, '');

/** A group in brackets at the front, or after a final dash (scene style). */
export const releaseGroup = (title: string): string | undefined => {
  const front = title.match(/^\s*\[([^\]]+)\]/);
  if (front) return front[1].trim();
  const back = title.match(/-([A-Za-z0-9][A-Za-z0-9.]*?)(\s*\[[^\]]*\])?\s*$/);
  return back && !/^\d+$/.test(back[1]) ? back[1] : undefined;
};

/**
 * The part of a name that describes the release rather than the show:
 * bracketed tags that carry quality, source, codec, audio or language, or,
 * in a dotted scene name, everything from the first such token on.
 */
export const releaseTags = (title: string): string => {
  const bracketed = [...title.matchAll(/[[(]([^\])]+)[\])]/g)]
    .map((m) => m[0])
    .slice(/^\s*\[/.test(title) ? 1 : 0)
    .filter((tag) => QUALITY_TOKEN.test(tag) && !PACK_ONLY.test(tag));
  if (bracketed.length) {
    return bracketed.join('');
  }
  const words = title.replace(/^\s*\[[^\]]*\]\s*/, '').split(/[\s.]+/);
  const first = words.findIndex((word) => QUALITY_TOKEN.test(word));
  if (first < 0) {
    return '';
  }
  return words
    .slice(first)
    .join(' ')
    .replace(/-[A-Za-z0-9.]+$/, '')
    .trim();
};

export interface FileNumbers {
  absolute?: number;
  season?: number;
  episode?: number;
  /** The last episode of a file that holds several (S01E01E02). */
  through?: number;
  version?: number;
}

/**
 * Episode numbers that can be read from a name directly. A number in
 * brackets after an SxxEyy is the absolute number (Judas, and others with
 * their own season split); " - 131v3" is an absolute number with a version.
 */
export const readNumbers = (name: string): FileNumbers => {
  const found: FileNumbers = {};
  // S01E01, S01E01E02, S01E01-E02, and S01E01-02 (but not S01E01-1080p).
  const sxe = name.match(
    /\bS(\d{1,2})E(\d{1,3})(?:-?E(\d{1,3})|-(\d{1,3})(?![\dp]))?\b/i
  );
  if (sxe) {
    found.season = Number(sxe[1]);
    found.episode = Number(sxe[2]);
    const last = Number(sxe[3] ?? sxe[4]);
    if (last > found.episode && last - found.episode < 10) {
      found.through = last;
    }
    const bracketed = name
      .slice((sxe.index ?? 0) + sxe[0].length)
      .match(/^\s*[[(](\d{1,4})[\])]/);
    if (bracketed) {
      found.absolute = Number(bracketed[1]);
    }
  }
  if (found.absolute === undefined && !sxe) {
    const dashed = name.match(/\s-\s(\d{1,4})(?:v(\d))?(?=$|[\s[(._])/);
    if (dashed) {
      found.absolute = Number(dashed[1]);
      if (dashed[2]) found.version = Number(dashed[2]);
    }
  }
  if (found.version === undefined) {
    const version = name.match(/\d(?:v|\.v)([2-9])(?=$|[\s[(._])/i);
    if (version) found.version = Number(version[1]);
  }
  return found;
};

/** The series' name in the form Sonarr matches: "Perfect World 2021". */
export const titleForParse = (seriesTitle: string): string =>
  seriesTitle.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();

const pad = (n: number, width: number) => String(n).padStart(width, '0');

export const canonicalName = (options: {
  fileName: string;
  packTitle: string;
  seriesTitle: string;
  number: {
    absolute?: number;
    season?: number;
    episode?: number;
    through?: number;
  };
  version?: number;
}): string => {
  const { fileName, packTitle, seriesTitle, number, version } = options;
  const group = releaseGroup(fileName) ?? releaseGroup(packTitle);
  const ownTags = releaseTags(fileName);
  const tags = /\b(480p|576p|720p|1080p|2160p)\b/i.test(ownTags)
    ? ownTags
    : [releaseTags(packTitle), ownTags].filter(Boolean).join(' ');
  const episode =
    number.absolute !== undefined
      ? `${pad(number.absolute, 2)}${
          number.through ? `-${pad(number.through, 2)}` : ''
        }`
      : `S${pad(number.season ?? 1, 2)}E${pad(number.episode ?? 0, 2)}${
          number.through ? `-E${pad(number.through, 2)}` : ''
        }`;
  const v = version && version > 1 ? `v${version}` : '';
  const title = titleForParse(seriesTitle);
  const scene = group && !/^\s*\[/.test(fileName) && !/^\s*\[/.test(packTitle);
  if (scene) {
    return `${title} ${episode}${v} ${tags}-${group}`.replace(/\s+/g, ' ');
  }
  return `${group ? `[${group}] ` : ''}${title} - ${episode}${v} ${tags}`
    .replace(/\s+/g, ' ')
    .trim();
};
