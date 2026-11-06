import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieResult,
  TmdbTvResult,
} from '@server/api/themoviedb/interfaces';
import { IssueStatus, IssueType } from '@server/constants/issue';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Issue from '@server/entity/Issue';
import IssueComment from '@server/entity/IssueComment';
import Media from '@server/entity/Media';
import MusicAlbum from '@server/entity/MusicAlbum';
import type { User } from '@server/entity/User';
import type { NamedTitle } from '@server/lib/ai/context';
import { label, withLibraryStatus } from '@server/lib/ai/context';
import type { NamedMusic } from '@server/lib/ai/music';
import { musicFor, resolveMusic } from '@server/lib/ai/music';
import type { FixKind, FixResult } from '@server/lib/autofix';
import autofix, { classify, seasonEpisodeIn } from '@server/lib/autofix';
import { Permission } from '@server/lib/permissions';
import type { MusicAlbumResult, MusicArtistResult } from '@server/models/Music';
import { In, MoreThan } from 'typeorm';

/*
 * Fixes from AI Search, for those who may report problems. Subtitles,
 * transcription and missing-episode searches run at once when the person's
 * own message asks for that fix of that title, and are otherwise offered
 * for confirmation. File-replacing fixes are always offered with the title
 * shown and run only after confirmation; they are filed as an issue
 * (record and status), then fixed in the background.
 *
 * Season/episode from the user's words beat the model's, so a model that
 * drops or misreads "season 6" can't turn it into All Seasons.
 */

interface ChatFix {
  kind: FixKind;
  title?: NamedTitle;
  /** Album or artist, for a music fix. */
  music?: NamedMusic;
  seasonNumber?: number;
  episodeNumber?: number;
  language?: string;
}

const ISSUE_TYPE: Partial<Record<FixKind, IssueType>> = {
  broken: IssueType.VIDEO,
  wrongEpisode: IssueType.OTHER,
  replaceSeason: IssueType.OTHER,
};

/** Fixes that replace files, filed as an issue. */
type FileFix = 'broken' | 'wrongEpisode' | 'replaceSeason';

/** A fix awaiting confirmation. */
export interface FixToConfirm {
  kind: FileFix | 'subtitles' | 'transcribe' | 'missing';
  mediaId: number;
  /** For a music fix: the album, when it is about one. */
  albumId?: number;
  seasonNumber?: number;
  episodeNumber?: number;
  language?: string;
  /** The user's text, used as the issue's first comment. */
  message: string;
}

const isFileFix = (kind: FixToConfirm['kind']): kind is FileFix =>
  ISSUE_TYPE[kind] !== undefined;

/** Fixing from AI Search needs the permission reporting a problem does. */
const mayReport = (user: User) =>
  user.hasPermission([Permission.CREATE_ISSUES, Permission.MANAGE_ISSUES], {
    type: 'or',
  });

const NOT_REPORTER =
  'Fixing a title needs permission to report problems. Ask an admin to look at it.';

const DAY = 24 * 60 * 60 * 1000;

type ChatResults = Awaited<ReturnType<typeof withLibraryStatus>>;

interface ChatFixAnswer {
  reply: string;
  results: ChatResults;
  /** The music fix's album or artist, shown like music results. */
  music?: { albums: MusicAlbumResult[]; artists: MusicArtistResult[] };
  fix?: Pick<FixResult, 'kind' | 'ok' | 'link'>;
  confirm?: FixToConfirm;
}

type Hit = TmdbMovieResult | TmdbTvResult;

const search = async (
  kind: 'movie' | 'tv',
  query: string,
  year?: number
): Promise<Hit[]> => {
  const tmdb = new TheMovieDb();
  try {
    return kind === 'movie'
      ? (await tmdb.searchMovies({ query, year })).results
      : (await tmdb.searchTvShows({ query, year })).results;
  } catch {
    return [];
  }
};

/** TMDB matches that are on the server, with their media. */
const onServer = async (kind: 'movie' | 'tv', hits: Hit[]) => {
  if (!hits.length) {
    return [];
  }
  const media = await getRepository(Media).find({
    where: {
      tmdbId: In(hits.map((hit) => hit.id)),
      mediaType: kind === 'movie' ? MediaType.MOVIE : MediaType.TV,
    },
  });
  return hits
    .map((result) => ({
      kind,
      result,
      media: media.find((m) => m.tmdbId === result.id),
    }))
    .filter((f): f is typeof f & { media: Media } => !!f.media);
};

/** Prefers one with files. */
const best = <T extends { media: Media }>(found: T[]): T | undefined =>
  found.find((f) =>
    [MediaStatus.AVAILABLE, MediaStatus.PARTIALLY_AVAILABLE].includes(
      f.media.status
    )
  ) ?? found[0];

const plain = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^the /, '');

/** Report words that are never part of a title. */
const NOT_TITLE = new RegExp(
  [
    String.raw`\bs\d{1,2}\s*e\d{1,3}\b`,
    String.raw`\b\d{1,2}x\d{2,3}\b`,
    String.raw`\b(?:season|episode|ep)\.?\s*\w+\b`,
    String.raw`\b(?:please|pls|can you|could you|would you|i want to|i need to|i need|help me|fix(?:es|ing|ed)?|repair|sort out|look at|replace|re-?download|re-?grab|get|find|download|search for|subtitles?|subs|captions?|transcribe|audio|sound|video|picture|file|is|are|was|were|has|have|had|keeps?|won'?t|wont|doesn'?t|does not|isn'?t|is not|not|no|never|playing|plays?|broken|corrupt\w*|missing|wrong|bad|messed up|out of sync|stutter\w*|buffer\w*|freez\w*)\b`,
    String.raw`[,.!?;"“”]`,
  ].join('|'),
  'gi'
);
const LEADING = /^(?:(?:on|in|for|with|of|to|at|from|the|a|an|my|this)\s+)+/i;

/**
 * The title in the user's words, for titles the model doesn't know or
 * renames: the longest stretch left after removing report words.
 */
export const titleInTheirWords = (message: string): string | undefined =>
  message
    .split(NOT_TITLE)
    .map((part) => part?.trim().replace(LEADING, '').trim())
    .filter((part): part is string => !!part && part.length >= 3)
    .sort((a, b) => b.length - a.length)[0];

/**
 * Resolves the intended title: the first TMDB match on the server,
 * preferring one with files, since TMDB's top hit may be a same-named newer
 * title and a fix must never hit the wrong one. Tries the model's name, then
 * the user's words (the model may rename or not know newer titles); those
 * count only for an on-server title named in full or the only candidate.
 * With none on the server, returns TMDB's first match for display.
 */
const findOnServer = async (
  title: NamedTitle | undefined,
  message: string
): Promise<{
  kind?: 'movie' | 'tv';
  result?: Hit;
  media?: Media;
}> => {
  let shown: { kind: 'movie' | 'tv'; result: Hit } | undefined;
  if (title) {
    // Try with the model's year first; a wrong year mustn't lose the title.
    const dated = title.y ? await search(title.k, title.t, title.y) : [];
    const found = best(await onServer(title.k, dated));
    if (found) {
      return found;
    }
    const any = await search(title.k, title.t);
    const again = best(await onServer(title.k, any));
    if (again) {
      return again;
    }
    const first = dated[0] ?? any[0];
    shown = first && { kind: title.k, result: first };
  }

  const words = titleInTheirWords(message);
  if (words && plain(words) !== plain(title?.t ?? '')) {
    const wanted = plain(words).split(' ');
    const kinds: ('movie' | 'tv')[] = title ? [title.k] : ['movie', 'tv'];
    const found = (
      await Promise.all(
        kinds.map(async (kind) => onServer(kind, await search(kind, words)))
      )
    )
      .flat()
      .map((f) => ({
        ...f,
        name: plain('title' in f.result ? f.result.title : f.result.name),
      }));
    const exact = found.filter((f) => f.name === plain(words));
    const named = found.filter((f) =>
      wanted.every((word) => f.name.split(' ').includes(word))
    );
    const match = best(exact) ?? (named.length === 1 ? named[0] : undefined);
    if (match) {
      return match;
    }
  }
  return shown ?? {};
};

/**
 * The user's open report of the same title/season/episode from the last day, if
 * any.
 */
export const reportedToday = (
  user: User,
  media: Media,
  seasonNumber?: number,
  episodeNumber?: number
): Promise<Issue | null> =>
  getRepository(Issue).findOne({
    where: {
      media: { id: media.id },
      createdBy: { id: user.id },
      status: IssueStatus.OPEN,
      problemSeason: seasonNumber ?? 0,
      problemEpisode: episodeNumber ?? 0,
      createdAt: MoreThan(new Date(Date.now() - DAY)),
    },
  });

/** Checks before offering a file-replacing fix, repeated on confirm. */
const refuseToFile = async (
  user: User,
  media: Media,
  fix: { kind: FixKind; seasonNumber?: number; episodeNumber?: number },
  results: ChatResults
): Promise<ChatFixAnswer | undefined> => {
  if (!mayReport(user)) {
    return { reply: NOT_REPORTER, results };
  }
  // Already reported today: the open issue covers it.
  const open = await reportedToday(
    user,
    media,
    fix.seasonNumber,
    fix.episodeNumber
  );
  if (open) {
    return {
      reply: 'You reported this already today; what happened is on the issue.',
      results,
      fix: { kind: fix.kind, ok: true, link: `/issues/${open.id}` },
    };
  }
  return undefined;
};

/**
 * Merges the model's reading with the user's words: their season/episode
 * win, and "whole season is bad" forces replaceSeason. `earlier` supplies a
 * season named in a prior message ("Fix season 6", then "replace all of it").
 */
export const readFix = (
  fix: ChatFix,
  message: string,
  earlier?: string
): ChatFix => {
  const said = seasonEpisodeIn(message);
  const before = earlier ? seasonEpisodeIn(earlier) : {};
  const kind =
    fix.kind !== 'subtitles' &&
    fix.kind !== 'transcribe' &&
    classify(message)?.kind === 'replaceSeason'
      ? 'replaceSeason'
      : fix.kind;
  const seasonNumber = said.season ?? fix.seasonNumber ?? before.season;
  const episodeNumber =
    kind === 'replaceSeason'
      ? undefined
      : (said.episode ??
        // Keep the model's episode only with its own season.
        (said.season === undefined || said.season === fix.seasonNumber
          ? fix.episodeNumber
          : undefined));
  return { ...fix, kind, seasonNumber, episodeNumber };
};

/** A message asking for a title to be fixed, without saying how. */
const FIX_WORDS = /\b(fix\w*|repair\w*|sort (it )?out|look (at|into))\b/i;

/** A message saying something is not there, beyond missing episodes. */
const MISSING_WORDS =
  /\b(missing|lost|gone|never (came|arrived|downloaded)|not (there|here|available|on the server)|(isn'?t|aren'?t) (there|here|available)|can'?t find)\b/i;

/**
 * Whether the person's own words ask for this fix of this title: their
 * message reads as that fix, and it or their previous message names the
 * title. Otherwise the model's reading of the conversation is only offered.
 */
const askedInTheirWords = (
  kind: FixKind,
  names: (string | undefined)[],
  message: string,
  earlier?: string
): boolean => {
  // Their words read as this fix, or ask for a fix and leave which to it.
  const read = classify(message)?.kind;
  const asked =
    read === kind ||
    (read === undefined &&
      (FIX_WORDS.test(message) ||
        (kind === 'missing' && MISSING_WORDS.test(message))));
  if (!asked) {
    return false;
  }
  const said = ` ${plain(`${message} ${earlier ?? ''}`)} `;
  return names.some((name) => {
    const wanted = name ? plain(name) : '';
    return !!wanted && said.includes(` ${wanted} `);
  });
};

/** What a fix that replaces nothing does, offered for confirmation. */
const offerText = (kind: FixKind, what: string) =>
  `${
    kind === 'subtitles'
      ? 'This gets subtitles for'
      : kind === 'transcribe'
        ? 'This makes subtitles from the audio of'
        : 'This searches again for what is missing of'
  } ${what}. Confirm to go ahead.`;

const MUSIC_FIXES =
  'For music, I can search again for an album’s missing tracks or an artist’s missing albums. For anything else, ask an admin.';

/**
 * Music fixes: re-search an album's missing tracks, an album that never
 * came, or an artist's missing albums. Other fix kinds are video-only.
 */
const fixMusicFromChat = async (
  user: User,
  kind: FixKind,
  named: NamedMusic,
  message: string,
  earlier?: string
): Promise<ChatFixAnswer> => {
  const found = await resolveMusic([named]);
  const shown = found.albums.length + found.artists.length ? found : undefined;
  if (kind !== 'missing') {
    return {
      reply: MUSIC_FIXES,
      results: [],
      ...(shown && { music: shown }),
    };
  }
  const albumResult = named.k === 'album' ? found.albums[0] : undefined;
  const artistId =
    albumResult?.artistId ??
    (named.k === 'artist' ? found.artists[0]?.id : undefined);
  if (!shown || !artistId) {
    return {
      reply: `I couldn't find ${named.k === 'album' ? 'that album' : 'that artist'} on MusicBrainz. Try the full name.`,
      results: [],
    };
  }
  const media = await getRepository(Media).findOne({
    where: { mediaType: MediaType.MUSIC, foreignId: artistId },
  });
  const album = albumResult
    ? await getRepository(MusicAlbum).findOne({
        where: { mbId: albumResult.id, mediaId: media?.id ?? -1 },
      })
    : undefined;
  if (!media || (albumResult && !album)) {
    return {
      reply: `${albumResult?.title ?? named.t} is not on the server yet, so there is nothing to fix. It can be requested instead.`,
      results: [],
      music: shown,
    };
  }
  if (
    !askedInTheirWords(
      kind,
      [named.t, albumResult?.title, album ? undefined : found.artists[0]?.name],
      message,
      earlier
    )
  ) {
    return {
      reply: offerText(kind, albumResult?.title ?? named.t),
      results: [],
      music: shown,
      confirm: {
        kind: 'missing',
        mediaId: media.id,
        ...(album && { albumId: album.id }),
        message,
      },
    };
  }
  const result = await autofix.run({
    kind,
    media,
    ...(album && { album }),
    user,
  });
  return {
    reply: result.message,
    results: [],
    music: shown,
    fix: { kind: result.kind, ok: result.ok, link: result.link },
  };
};

export const fixFromChat = async (
  user: User,
  message: string,
  asked: ChatFix,
  earlier?: string
): Promise<ChatFixAnswer> => {
  if (!autofix.enabledFor(user)) {
    return { reply: 'Fixing problems from here is turned off.', results: [] };
  }
  if (!mayReport(user)) {
    return { reply: NOT_REPORTER, results: [] };
  }
  const fix = readFix(asked, message, earlier);
  if (!fix.title && fix.music && musicFor(user)) {
    return fixMusicFromChat(user, fix.kind, fix.music, message, earlier);
  }
  const {
    kind: titleKind,
    result,
    media,
  } = await findOnServer(fix.title, message);
  if (!titleKind || !result) {
    return {
      reply: fix.title
        ? `Nothing on TMDB or the server matches “${fix.title.t}”. Try the full title.`
        : 'Which title is it? Name the movie or series (and the episode).',
      results: [],
    };
  }
  const results = await withLibraryStatus(user, [{ kind: titleKind, result }]);
  const mediaType = titleKind === 'movie' ? MediaType.MOVIE : MediaType.TV;
  if (!media) {
    return {
      reply: `${'title' in result ? result.title : result.name} is not on the server yet, so there is nothing to fix. It can be requested instead.`,
      results,
    };
  }

  const episode =
    mediaType === MediaType.TV && fix.seasonNumber
      ? ` season ${fix.seasonNumber}${
          fix.episodeNumber ? ` episode ${fix.episodeNumber}` : ''
        }`
      : '';
  const issueType = ISSUE_TYPE[fix.kind];
  if (issueType === undefined) {
    const name = 'title' in result ? result.title : result.name;
    if (!askedInTheirWords(fix.kind, [name, fix.title?.t], message, earlier)) {
      return {
        reply: offerText(fix.kind, `${label(result)}${episode}`),
        results,
        confirm: {
          kind: fix.kind,
          mediaId: media.id,
          seasonNumber:
            mediaType === MediaType.TV ? fix.seasonNumber : undefined,
          episodeNumber:
            mediaType === MediaType.TV ? fix.episodeNumber : undefined,
          language: fix.language,
          message,
        },
      };
    }
    const done = await autofix.run({
      kind: fix.kind,
      media,
      seasonNumber: fix.seasonNumber,
      episodeNumber: fix.episodeNumber,
      language: fix.language,
      user,
    });
    return {
      reply: done.message,
      results,
      fix: { kind: done.kind, ok: done.ok, link: done.link },
    };
  }

  // A movie's "whole season" is its one file.
  const kind = (
    fix.kind === 'replaceSeason' && mediaType === MediaType.MOVIE
      ? 'broken'
      : fix.kind
  ) as FixToConfirm['kind'];
  if (kind === 'replaceSeason' && fix.seasonNumber === undefined) {
    return {
      reply: `Which season of ${label(result)} should be replaced? Say its number, for example “replace season 2”.`,
      results,
    };
  }
  const refused = await refuseToFile(user, media, { ...fix, kind }, results);
  if (refused) {
    return refused;
  }
  // Offer only: it replaces files, so the user confirms the title first.
  const admin = user.hasPermission(Permission.ADMIN);
  return {
    reply:
      kind === 'replaceSeason'
        ? `This replaces all of season ${fix.seasonNumber} of ${label(result)} with another release: the new one is downloaded first, and the current files are removed only once it is grabbed. ${
            admin
              ? 'Confirm to go ahead.'
              : 'An admin approves it first. Confirm to ask for it.'
          }`
        : kind === 'wrongEpisode' && mediaType === MediaType.TV
          ? `This checks ${label(result)}${episode} against where each file came from, and replaces what is wrong. Confirm to go ahead.`
          : `This replaces the file of ${label(result)}${episode} with another release. Confirm to go ahead.`,
    results,
    confirm: {
      kind,
      mediaId: media.id,
      seasonNumber: mediaType === MediaType.TV ? fix.seasonNumber : undefined,
      episodeNumber:
        mediaType === MediaType.TV && kind !== 'replaceSeason'
          ? fix.episodeNumber
          : undefined,
      message,
    },
  };
};

/**
 * Starts a confirmed fix. One that replaces files is filed as an issue
 * first.
 */
export const confirmFix = async (
  user: User,
  fix: FixToConfirm
): Promise<ChatFixAnswer> => {
  if (!autofix.enabledFor(user)) {
    return { reply: 'Fixing problems from here is turned off.', results: [] };
  }
  const media = await getRepository(Media).findOne({
    where: { id: fix.mediaId },
  });
  if (!media) {
    return { reply: 'That title is no longer on the server.', results: [] };
  }
  if (!isFileFix(fix.kind)) {
    if (!mayReport(user)) {
      return { reply: NOT_REPORTER, results: [] };
    }
    const album =
      media.mediaType === MediaType.MUSIC && fix.albumId !== undefined
        ? await getRepository(MusicAlbum).findOne({
            where: { id: fix.albumId, mediaId: media.id },
          })
        : undefined;
    if (album === null) {
      return { reply: 'That album is no longer on the server.', results: [] };
    }
    const result = await autofix.run({
      kind: fix.kind,
      media,
      ...(album && { album }),
      seasonNumber: fix.seasonNumber,
      episodeNumber: fix.episodeNumber,
      language: fix.language,
      user,
    });
    return {
      reply: result.message,
      results: [],
      fix: { kind: result.kind, ok: result.ok, link: result.link },
    };
  }
  // Files are replaced only for films and series.
  if (media.mediaType === MediaType.MUSIC) {
    return { reply: MUSIC_FIXES, results: [] };
  }
  const refused = await refuseToFile(user, media, fix, []);
  if (refused) {
    return refused;
  }
  const issue = await getRepository(Issue).save(
    new Issue({
      createdBy: user,
      issueType: ISSUE_TYPE[fix.kind] ?? IssueType.OTHER,
      problemSeason: fix.seasonNumber ?? 0,
      problemEpisode: fix.episodeNumber ?? 0,
      media,
      comments: [
        new IssueComment({
          user,
          // A photo-only report gets placeholder text.
          message: fix.message.trim() || 'Reported with a photo.',
        }),
      ],
    })
  );
  void autofix.fromIssue(issue.id, { actor: user, asked: { kind: fix.kind } });
  if (fix.kind === 'replaceSeason' && media.mediaType === MediaType.TV) {
    return {
      reply: user.hasPermission(Permission.ADMIN)
        ? `Reported it, and started replacing season ${fix.seasonNumber}: another release is being looked for, and the current files are removed only once it is grabbed. What happens is written on the issue, and you will be told.`
        : `Reported it. Replacing a whole season needs an admin’s approval: another release is being looked for now, and an admin is asked to approve it. What happens is written on the issue, and you will be told.`,
      results: [],
      fix: { kind: fix.kind, ok: true, link: `/issues/${issue.id}` },
    };
  }
  return {
    reply: `Reported it, and started fixing it: ${
      fix.kind === 'wrongEpisode' && media.mediaType === MediaType.TV
        ? 'the season is being checked against where each file came from, and what is wrong will be replaced.'
        : 'another release will replace the file once one is found.'
    } What happens is written on the issue, and you will be told.`,
    results: [],
    fix: { kind: fix.kind, ok: true, link: `/issues/${issue.id}` },
  };
};
