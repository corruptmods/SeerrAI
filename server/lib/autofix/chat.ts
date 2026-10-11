import { IssueStatus, IssueType } from '@server/constants/issue';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Issue from '@server/entity/Issue';
import IssueComment from '@server/entity/IssueComment';
import Media from '@server/entity/Media';
import type { User } from '@server/entity/User';
import type { NamedTitle } from '@server/lib/ai/context';
import { resolveTitles } from '@server/lib/ai/context';
import type { FixKind, FixResult } from '@server/lib/autofix';
import autofix from '@server/lib/autofix';
import { Permission } from '@server/lib/permissions';
import { MoreThan } from 'typeorm';

/*
 * A fix asked for in AI Search. Subtitles, transcriptions and searches for
 * missing episodes are done at once. A broken or wrong episode removes a
 * file, so it needs permission to report issues: it is filed as one, for a
 * record and to tell the person how it went, and fixed in the background.
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

const DAY = 24 * 60 * 60 * 1000;

export const fixFromChat = async (
  user: User,
  message: string,
  fix: ChatFix
): Promise<{
  reply: string;
  results: Awaited<ReturnType<typeof resolveTitles>>;
  fix?: Pick<FixResult, 'kind' | 'ok' | 'link'>;
}> => {
  if (!autofix.enabledFor(user)) {
    return { reply: 'Fixing problems from here is turned off.', results: [] };
  }
  if (!fix.title) {
    return {
      reply: 'Which title is it? Name the movie or series (and the episode).',
      results: [],
    };
  }
  const results = await resolveTitles(user, [fix.title]);
  if (!results.length) {
    return {
      reply: `TMDB has nothing called “${fix.title.t}”. Try the full title.`,
      results: [],
    };
  }
  const mediaType = fix.title.k === 'movie' ? MediaType.MOVIE : MediaType.TV;
  const media = await getRepository(Media).findOne({
    where: { tmdbId: results[0].id, mediaType },
  });
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
  const issue = await getRepository(Issue).save(
    new Issue({
      createdBy: user,
      issueType,
      problemSeason: fix.seasonNumber ?? 0,
      problemEpisode: fix.episodeNumber ?? 0,
      media,
      comments: [new IssueComment({ user, message })],
    })
  );
  void autofix.fromIssue(issue.id, { actor: user, asked: { kind: fix.kind } });
  return {
    reply: `Reported it, and started fixing it: ${
      fix.kind === 'wrongEpisode' && mediaType === MediaType.TV
        ? 'the season is being checked against where each file came from, and what is wrong will be replaced.'
        : 'another release will replace the file once one is found.'
    } What happens is written on the issue, and you will be told.`,
    results,
    fix: { kind: fix.kind, ok: true, link: `/issues/${issue.id}` },
  };
};
