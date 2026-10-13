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
import type { User } from '@server/entity/User';
import type { NamedTitle } from '@server/lib/ai/context';
import { label, withLibraryStatus } from '@server/lib/ai/context';
import type { FixKind, FixResult } from '@server/lib/autofix';
import autofix from '@server/lib/autofix';
import { Permission } from '@server/lib/permissions';
import { In, MoreThan } from 'typeorm';

/*
 * A fix asked for in AI Search. Subtitles, transcriptions and searches for
 * missing episodes are done at once. A broken or wrong episode removes a
 * file, so it is only offered, with the title it is for shown, and done
 * once the person confirms. It needs permission to report issues: it is
 * filed as one, for a record and to tell the person how it went, and fixed
 * in the background.
 */

interface ChatFix {
  kind: FixKind;
  title?: NamedTitle;
  seasonNumber?: number;
  episodeNumber?: number;
  language?: string;
}

const ISSUE_TYPE: Partial<Record<FixKind, IssueType>> = {
  broken: IssueType.VIDEO,
  wrongEpisode: IssueType.OTHER,
};

/** A fix that replaces files, waiting for the person to confirm it. */
export interface FixToConfirm {
  kind: 'broken' | 'wrongEpisode';
  mediaId: number;
  seasonNumber?: number;
  episodeNumber?: number;
  /** What they wrote: the issue's first comment. */
  message: string;
}

const DAY = 24 * 60 * 60 * 1000;

type ChatResults = Awaited<ReturnType<typeof withLibraryStatus>>;

interface ChatFixAnswer {
  reply: string;
  results: ChatResults;
  fix?: Pick<FixResult, 'kind' | 'ok' | 'link'>;
  confirm?: FixToConfirm;
}

/**
 * Which title the person means: of TMDB's matches for the name, the first
 * on the server, one with files before one without. TMDB's first match can
 * be a newer film or series of the same name, and a fix must never act on
 * the wrong one. Without any on the server, TMDB's first match, to show.
 */
const findOnServer = async (
  title: NamedTitle
): Promise<{
  result?: TmdbMovieResult | TmdbTvResult;
  media?: Media;
}> => {
  const tmdb = new TheMovieDb();
  const mediaType = title.k === 'movie' ? MediaType.MOVIE : MediaType.TV;
  const search = async (
    year?: number
  ): Promise<(TmdbMovieResult | TmdbTvResult)[]> => {
    try {
      return title.k === 'movie'
        ? (await tmdb.searchMovies({ query: title.t, year })).results
        : (await tmdb.searchTvShows({ query: title.t, year })).results;
    } catch {
      return [];
    }
  };
  const onServer = async (hits: (TmdbMovieResult | TmdbTvResult)[]) => {
    if (!hits.length) {
      return undefined;
    }
    const media = await getRepository(Media).find({
      where: { tmdbId: In(hits.map((hit) => hit.id)), mediaType },
    });
    const found = hits
      .map((result) => ({
        result,
        media: media.find((m) => m.tmdbId === result.id),
      }))
      .filter((f): f is { result: typeof f.result; media: Media } => !!f.media);
    return (
      found.find((f) =>
        [MediaStatus.AVAILABLE, MediaStatus.PARTIALLY_AVAILABLE].includes(
          f.media.status
        )
      ) ?? found[0]
    );
  };

  // The year narrows it when the model gave one; a wrong year should not
  // lose a title that is there.
  const dated = title.y ? await search(title.y) : [];
  const found = await onServer(dated);
  if (found) {
    return found;
  }
  const any = await search();
  return (await onServer(any)) ?? { result: dated[0] ?? any[0] };
};

/** The checks before a file-replacing fix is offered, and again when done. */
const refuseToFile = async (
  user: User,
  media: Media,
  fix: { kind: FixKind; seasonNumber?: number; episodeNumber?: number },
  results: ChatResults
): Promise<ChatFixAnswer | undefined> => {
  if (
    !user.hasPermission([Permission.CREATE_ISSUES, Permission.MANAGE_ISSUES], {
      type: 'or',
    })
  ) {
    return {
      reply:
        'Replacing a file needs permission to report problems. Ask an admin to look at it.',
      results,
    };
  }
  // Asked again about the same episode: the open report already covers it.
  const open = await getRepository(Issue).findOne({
    where: {
      media: { id: media.id },
      createdBy: { id: user.id },
      status: IssueStatus.OPEN,
      problemSeason: fix.seasonNumber ?? 0,
      problemEpisode: fix.episodeNumber ?? 0,
      createdAt: MoreThan(new Date(Date.now() - DAY)),
    },
  });
  if (open) {
    return {
      reply: 'You reported this already today; what happened is on the issue.',
      results,
      fix: { kind: fix.kind, ok: true, link: `/issues/${open.id}` },
    };
  }
  return undefined;
};

export const fixFromChat = async (
  user: User,
  message: string,
  fix: ChatFix
): Promise<ChatFixAnswer> => {
  if (!autofix.enabledFor(user)) {
    return { reply: 'Fixing problems from here is turned off.', results: [] };
  }
  if (!fix.title) {
    return {
      reply: 'Which title is it? Name the movie or series (and the episode).',
      results: [],
    };
  }
  const { result, media } = await findOnServer(fix.title);
  if (!result) {
    return {
      reply: `TMDB has nothing called “${fix.title.t}”. Try the full title.`,
      results: [],
    };
  }
  const results = await withLibraryStatus(user, [
    { kind: fix.title.k, result },
  ]);
  const mediaType = fix.title.k === 'movie' ? MediaType.MOVIE : MediaType.TV;
  if (!media) {
    return {
      reply: `${fix.title.t} is not on the server yet, so there is nothing to fix. It can be requested instead.`,
      results,
    };
  }

  const issueType = ISSUE_TYPE[fix.kind];
  if (issueType === undefined) {
    const result = await autofix.run({
      kind: fix.kind,
      media,
      seasonNumber: fix.seasonNumber,
      episodeNumber: fix.episodeNumber,
      language: fix.language,
      user,
    });
    return {
      reply: result.message,
      results,
      fix: { kind: result.kind, ok: result.ok, link: result.link },
    };
  }

  const refused = await refuseToFile(user, media, fix, results);
  if (refused) {
    return refused;
  }
  const kind = fix.kind as FixToConfirm['kind'];
  const episode =
    mediaType === MediaType.TV && fix.seasonNumber
      ? ` season ${fix.seasonNumber}${
          fix.episodeNumber ? ` episode ${fix.episodeNumber}` : ''
        }`
      : '';
  // Offered, not done: it replaces files, so the person sees which title
  // it is for and confirms it.
  return {
    reply:
      kind === 'wrongEpisode' && mediaType === MediaType.TV
        ? `This checks ${label(result)}${episode} against where each file came from, and replaces what is wrong. Confirm to go ahead.`
        : `This replaces the file of ${label(result)}${episode} with another release. Confirm to go ahead.`,
    results,
    confirm: {
      kind,
      mediaId: media.id,
      seasonNumber: fix.seasonNumber,
      episodeNumber: fix.episodeNumber,
      message,
    },
  };
};

/** A file-replacing fix the person confirmed: filed, and started. */
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
          // The issue's first comment is what they wrote; a photo alone
          // says so.
          message: fix.message.trim() || 'Reported with a photo.',
        }),
      ],
    })
  );
  void autofix.fromIssue(issue.id, { actor: user, asked: { kind: fix.kind } });
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
