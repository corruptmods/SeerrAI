import TheMovieDb from '@server/api/themoviedb';
import { IssueType } from '@server/constants/issue';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Issue from '@server/entity/Issue';
import IssueComment from '@server/entity/IssueComment';
import Media from '@server/entity/Media';
import type { User } from '@server/entity/User';
import type { FixKind } from '@server/lib/autofix';
import autofix, { readReport, seasonEpisodeIn } from '@server/lib/autofix';
import { reportedToday } from '@server/lib/autofix/chat';
import { REPLACES_FILES } from '@server/lib/autofix/understand';
import type { NowPlaying } from '@server/lib/nowPlaying';
import nowPlaying from '@server/lib/nowPlaying';
import { Permission } from '@server/lib/permissions';
import logger from '@server/logger';
import { randomBytes } from 'node:crypto';
import { In } from 'typeorm';

/*
 * "Fix this show" from Siri. The shortcut asks what is playing, asks the
 * person what's wrong, and sends their words here. The report is filed as
 * an issue, as one made in Seerr would be, and fixed in the background:
 * the word rules read it, and the AI model when they can't tell. A fix
 * that replaces files is asked about first, whoever read it, and done
 * only on a "yes". Everything comes back as a sentence for Siri to say.
 */

/** How long a "Should I go ahead?" waits for its answer. */
export const ANSWER_WITHIN_MS = 5 * 60 * 1000;
/** The most a report says, in characters: what Siri heard. */
export const MOST_CHARACTERS = 1000;

/** A refusal with the sentence to say and the HTTP status to send. */
export class SiriError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

export interface SiriPlaying {
  /** What to send back with the report: the title, season and episode. */
  item: string;
  mediaId: number;
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  title: string;
  season?: number;
  episode?: number;
  /** Playing now, or stopped in the last half hour. */
  seen: 'now' | 'recent';
}

export interface SiriAnswer {
  /** The sentence for Siri to say. */
  say: string;
  /** A question waits for a yes or no: send this back with the answer. */
  confirm?: string;
  issueId?: number;
}

interface Asked {
  userId: number;
  mediaId: number;
  season?: number;
  episode?: number;
  problem: string;
  kind: FixKind;
  until: number;
}

const ISSUE_TYPE: Record<FixKind, IssueType> = {
  subtitles: IssueType.SUBTITLES,
  transcribe: IssueType.SUBTITLES,
  missing: IssueType.OTHER,
  broken: IssueType.VIDEO,
  wrongEpisode: IssueType.OTHER,
  replaceSeason: IssueType.OTHER,
};

/** "The Bear, season 2 episode 3", as Siri says it. */
export const spokenName = (p: {
  title: string;
  season?: number;
  episode?: number;
}): string =>
  p.season === undefined
    ? p.title
    : `${p.title}, season ${p.season}${
        p.episode === undefined ? '' : ` episode ${p.episode}`
      }`;

/** The item a title is sent back as: its id, then season and episode. */
export const itemOf = (p: {
  media: { id: number };
  season?: number;
  episode?: number;
}): string =>
  p.season === undefined
    ? String(p.media.id)
    : `${p.media.id}:${p.season}:${p.episode ?? ''}`;

const ITEM = /^(\d{1,9})(?::(\d{1,3}):(\d{1,4})?)?$/;

export const parseItem = (
  item: string
): { mediaId: number; season?: number; episode?: number } | undefined => {
  const m = ITEM.exec(item);
  if (!m) return undefined;
  return {
    mediaId: Number(m[1]),
    ...(m[2] !== undefined ? { season: Number(m[2]) } : {}),
    ...(m[3] ? { episode: Number(m[3]) } : {}),
  };
};

const mayReport = (user: User) =>
  user.hasPermission([Permission.CREATE_ISSUES, Permission.MANAGE_ISSUES], {
    type: 'or',
  });

class SiriReports {
  private asked = new Map<string, Asked>();
  /** What each person was last offered, for the title's name. */
  private offered = new Map<number, { until: number; list: SiriPlaying[] }>();

  /** Forgets every question waiting for an answer. For tests. */
  public reset(): void {
    this.asked.clear();
    this.offered.clear();
  }

  /**
   * What they are watching, and what Siri asks next: "What's wrong with
   * The Bear, season 2 episode 3?", or that nothing is playing.
   */
  public async playing(
    user: User,
    kind?: MediaType.MOVIE | MediaType.TV
  ): Promise<{ playing: SiriPlaying[]; item?: string; say: string }> {
    const found = await nowPlaying.playingFor(user, kind);
    const playing = found.map(
      (p: NowPlaying): SiriPlaying => ({
        item: itemOf(p),
        mediaId: p.media.id,
        tmdbId: p.media.tmdbId,
        mediaType: p.media.mediaType === MediaType.MOVIE ? 'movie' : 'tv',
        title: p.title,
        season: p.season,
        episode: p.episode,
        seen: p.seen,
      })
    );
    this.forgetOld();
    this.offered.set(user.id, {
      until: Date.now() + ANSWER_WITHIN_MS,
      list: playing,
    });
    const first = playing[0];
    if (!first) {
      return {
        playing,
        say: 'Nothing is playing for you on the server, and you haven’t watched anything in the last half hour.',
      };
    }
    return {
      playing,
      item: first.item,
      say: `What’s wrong with ${spokenName(first)}?`,
    };
  }

  /** Where a report is about: the item sent, or what is playing now. */
  private async target(
    user: User,
    item: string | undefined,
    kind?: MediaType.MOVIE | MediaType.TV
  ): Promise<{
    media: Media;
    title: string;
    season?: number;
    episode?: number;
  }> {
    if (item) {
      const parsed = parseItem(item);
      // Films and series only: what can be playing.
      const media = parsed
        ? await getRepository(Media).findOne({
            where: {
              id: parsed.mediaId,
              mediaType: In([MediaType.MOVIE, MediaType.TV]),
            },
          })
        : null;
      if (!parsed || !media) {
        throw new SiriError('That title isn’t on the server any more.', 404);
      }
      return {
        media,
        title:
          this.offered.get(user.id)?.list.find((p) => p.mediaId === media.id)
            ?.title ?? (await titleOf(media)),
        season: media.mediaType === MediaType.TV ? parsed.season : undefined,
        episode: media.mediaType === MediaType.TV ? parsed.episode : undefined,
      };
    }
    const [first] = await nowPlaying.playingFor(user, kind);
    if (!first) {
      throw new SiriError(
        'Nothing is playing for you on the server, so there’s nothing to report.',
        404
      );
    }
    return first;
  }

  /**
   * A report of what's wrong. Filed and fixed at once, unless the fix
   * replaces files: then a question comes back, with a `confirm` to send
   * with the answer.
   */
  public async report(
    user: User,
    {
      problem,
      item,
      kind,
    }: {
      problem: string;
      item?: string;
      kind?: MediaType.MOVIE | MediaType.TV;
    }
  ): Promise<SiriAnswer> {
    if (!mayReport(user)) {
      throw new SiriError('You don’t have permission to report problems.', 403);
    }
    const words = problem.trim();
    if (!words) throw new SiriError('Say what’s wrong with it.', 400);
    if (words.length > MOST_CHARACTERS) {
      throw new SiriError('That’s too long. Say it in a sentence or two.', 400);
    }
    const at = await this.target(user, item, kind);
    const tv = at.media.mediaType === MediaType.TV;
    // A season or episode they name wins over what was playing.
    const said = tv ? seasonEpisodeIn(words) : {};
    const season = said.season ?? at.season;
    const episode =
      said.season !== undefined && said.season !== at.season
        ? said.episode
        : (said.episode ?? at.episode);

    const read = autofix.enabledFor(user)
      ? await readReport(words, { user, episode: tv })
      : undefined;
    let fixKind = read?.kind;
    if (fixKind === 'replaceSeason' && !tv) fixKind = 'broken';
    const where = {
      title: at.title,
      season,
      episode: fixKind === 'replaceSeason' ? undefined : episode,
    };

    const open = await reportedToday(
      user,
      at.media,
      where.season,
      where.episode
    );
    if (open) {
      return {
        say: 'You reported that already today. What happens is written on the issue.',
        issueId: open.id,
      };
    }

    if (fixKind && REPLACES_FILES.includes(fixKind)) {
      if (fixKind === 'replaceSeason' && season === undefined) {
        throw new SiriError(
          'Which season? Say its number, like “replace season 2”.',
          400
        );
      }
      const token = this.ask({
        userId: user.id,
        mediaId: at.media.id,
        season: where.season,
        episode: where.episode,
        problem: words,
        kind: fixKind,
        until: Date.now() + ANSWER_WITHIN_MS,
      });
      return { say: this.question(user, fixKind, where), confirm: token };
    }

    const issue = await this.file(user, at.media, {
      kind: fixKind,
      season: where.season,
      episode: where.episode,
      problem: words,
    });
    if (fixKind && read) {
      void autofix.fromIssue(issue.id, {
        actor: user,
        asked: {
          kind: fixKind,
          language: read.language,
          replace: read.replace,
        },
      });
    }
    return {
      say: this.started(user, fixKind, where, read?.language),
      issueId: issue.id,
    };
  }

  /** A yes or no to "Should I go ahead?". */
  public async answer(
    user: User,
    token: string,
    yes: boolean
  ): Promise<SiriAnswer> {
    this.forgetOld();
    const asked = this.asked.get(token);
    if (!asked || asked.userId !== user.id) {
      throw new SiriError(
        'That question has run out. Report it again to start over.',
        410
      );
    }
    this.asked.delete(token);
    // Checked again: permissions and reports can change in five minutes.
    if (!mayReport(user)) {
      throw new SiriError('You don’t have permission to report problems.', 403);
    }
    const media = await getRepository(Media).findOne({
      where: { id: asked.mediaId },
    });
    if (!media) {
      throw new SiriError('That title isn’t on the server any more.', 404);
    }
    const open = await reportedToday(user, media, asked.season, asked.episode);
    if (open) {
      return {
        say: 'You reported that already today. What happens is written on the issue.',
        issueId: open.id,
      };
    }
    const issue = await this.file(user, media, {
      kind: asked.kind,
      season: asked.season,
      episode: asked.episode,
      problem: asked.problem,
    });
    if (!yes) {
      return {
        say: 'Okay. I reported it for an admin and left the files as they are.',
        issueId: issue.id,
      };
    }
    void autofix.fromIssue(issue.id, {
      actor: user,
      asked: { kind: asked.kind },
    });
    return {
      say: this.started(user, asked.kind, {
        title: '',
        season: asked.season,
        episode: asked.episode,
      }),
      issueId: issue.id,
    };
  }

  private ask(asked: Asked): string {
    this.forgetOld();
    // One question waits per person: a new report replaces the last.
    for (const [token, waiting] of this.asked) {
      if (waiting.userId === asked.userId) this.asked.delete(token);
    }
    const token = randomBytes(12).toString('base64url');
    this.asked.set(token, asked);
    return token;
  }

  private forgetOld(): void {
    const now = Date.now();
    for (const [token, asked] of this.asked) {
      if (asked.until <= now) this.asked.delete(token);
    }
    for (const [userId, offered] of this.offered) {
      if (offered.until <= now) this.offered.delete(userId);
    }
  }

  private question(
    user: User,
    kind: FixKind,
    where: { title: string; season?: number; episode?: number }
  ): string {
    const name = spokenName(where);
    if (kind === 'replaceSeason') {
      return user.hasPermission(Permission.ADMIN)
        ? `That replaces all of season ${where.season} of ${where.title}. Should I go ahead?`
        : `That asks an admin to replace all of season ${where.season} of ${where.title}. Should I ask?`;
    }
    if (kind === 'wrongEpisode' && where.season !== undefined) {
      return `That checks ${name} against where each file came from, and replaces what’s wrong. Should I go ahead?`;
    }
    return `That replaces the file of ${name} with another copy. Should I go ahead?`;
  }

  private started(
    user: User,
    kind: FixKind | undefined,
    where: { title: string; season?: number; episode?: number },
    language?: string
  ): string {
    const after = ' You’ll be told how it goes.';
    switch (kind) {
      case undefined:
        return autofix.enabledFor(user)
          ? 'I reported it for an admin. I couldn’t tell what to fix: saying subtitles, wrong episode or bad quality lets me fix it straight away.'
          : 'I reported it for an admin.';
      case 'subtitles':
        return `Reported. I’m looking for ${
          language ? `${languageName(language)} ` : ''
        }subtitles now.${after}`;
      case 'transcribe':
        return `Reported. Subtitles are being made from the audio.${after}`;
      case 'missing':
        return `Reported. I’m searching for what’s missing.${after}`;
      case 'replaceSeason':
        return user.hasPermission(Permission.ADMIN)
          ? `Reported. Another release of season ${where.season} is being looked for, and the current files are removed only once it’s grabbed.${after}`
          : `Reported. An admin is asked to approve replacing season ${where.season}.${after}`;
      case 'wrongEpisode':
        return `Reported. The season is being checked, and what’s wrong will be replaced.${after}`;
      case 'broken':
        return `Reported. Another copy will replace the file once one is found.${after}`;
    }
  }

  /** The report as an issue, their words its first comment. */
  private file(
    user: User,
    media: Media,
    {
      kind,
      season,
      episode,
      problem,
    }: { kind?: FixKind; season?: number; episode?: number; problem: string }
  ): Promise<Issue> {
    logger.info('Problem reported with Siri', {
      label: 'Siri',
      userId: user.id,
      mediaId: media.id,
      kind: kind ?? 'unclear',
    });
    return getRepository(Issue).save(
      new Issue({
        createdBy: user,
        issueType: kind ? ISSUE_TYPE[kind] : IssueType.OTHER,
        problemSeason: season ?? 0,
        problemEpisode: episode ?? 0,
        media,
        comments: [new IssueComment({ user, message: problem })],
      })
    );
  }
}

/** A title's name from TMDB, for one sent back without being offered. */
const titleOf = async (media: Media): Promise<string> => {
  try {
    const tmdb = new TheMovieDb();
    return media.mediaType === MediaType.MOVIE
      ? (await tmdb.getMovie({ movieId: media.tmdbId })).title
      : (await tmdb.getTvShow({ tvId: media.tmdbId })).name;
  } catch {
    return media.mediaType === MediaType.MOVIE ? 'this film' : 'this series';
  }
};

const NAMES = new Intl.DisplayNames(['en'], { type: 'language' });
const languageName = (code: string) => {
  try {
    return NAMES.of(code) ?? code;
  } catch {
    return code;
  }
};

const siri = new SiriReports();
export default siri;
