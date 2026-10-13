import TheMovieDb from '@server/api/themoviedb';
import { IssueStatus, IssueTypeName } from '@server/constants/issue';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Issue from '@server/entity/Issue';
import Media from '@server/entity/Media';
import {
  MediaList,
  MediaListItem,
  MediaListMember,
} from '@server/entity/MediaList';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import agent from '@server/lib/agent';
import { AiError, askAi, askAiJson, cacheKey } from '@server/lib/ai';
import type { Activity, NamedTitle } from '@server/lib/ai/context';
import {
  ago,
  clip,
  label,
  recentActivity,
  recentWatching,
  resolveTitles,
} from '@server/lib/ai/context';
import { preparePhoto } from '@server/lib/ai/photo';
import type { CompletionImage } from '@server/lib/ai/providers';
import type { TitleSource } from '@server/lib/ai/titleSource';
import { titlesFromSource } from '@server/lib/ai/titleSource';
import { FIX_KINDS } from '@server/lib/autofix';
import { fixFromChat } from '@server/lib/autofix/chat';
import { getDeletingSoon } from '@server/lib/deletingSoon';
import { featureEnabled } from '@server/lib/features';
import { Permission } from '@server/lib/permissions';
import { getSeriesProgress } from '@server/lib/seriesProgress';
import { getSuggestions } from '@server/lib/suggestions';
import { getWatchedBy } from '@server/lib/watchedBy';
import logger from '@server/logger';
import { mapMovieResult, mapTvResult } from '@server/models/Search';
import { mapWithConcurrency } from '@server/utils/mapWithConcurrency';
import { createHash } from 'node:crypto';
import { In } from 'typeorm';
import { z } from 'zod';

/*
 * The AI features. Each sends the model only what that answer needs: a
 * short instruction, titles as "Name (year)" rather than whole records, list
 * positions rather than ids, and a small cap on the reply. Replies that feed
 * the page are compact JSON with one-letter keys.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Text from the model, trimmed to size rather than rejected for it. */
const text = (max: number) => z.string().transform((value) => clip(value, max));

const namedTitle = z.object({
  t: z.string().min(1).max(300),
  y: z.number().int().min(1870).max(2100).nullish(),
  k: z.enum(['movie', 'tv']),
});

// ---- the AI chat: find by description, ask for something -----------------

/** A reply's titles: up to 6 usually, up to 20 when making a list. */
const CHAT_TITLES_MAX = 20;

export interface ChatTurn {
  /** What the person wrote. */
  ask: string;
  /** What was said back, so "yes" answers the question that was asked. */
  reply?: string;
  /** The titles offered in reply, as labels. */
  offered: string[];
}

/**
 * Which whole set the model means, however it put it. Small models name
 * the fields and kinds loosely ("filmography", "studio", "name" for "q",
 * a flat "set":"director"), and a set lost to that was an answer with no
 * titles and nothing to confirm; so this reads any of those shapes.
 */
const SET_KINDS: Record<string, TitleSource['k']> = {
  collection: 'collection',
  series: 'collection',
  franchise: 'collection',
  saga: 'collection',
  keyword: 'keyword',
  universe: 'keyword',
  theme: 'keyword',
  topic: 'keyword',
  company: 'company',
  studio: 'company',
  person: 'person',
  filmography: 'person',
  director: 'person',
  actor: 'person',
  actress: 'person',
  cast: 'person',
};

const readSet = (raw: Record<string, unknown>): TitleSource | null => {
  const word = (value: unknown) =>
    typeof value === 'string' ? value.trim().toLowerCase() : '';
  const nested = [raw.src, raw.set, raw.source].find(
    (value): value is Record<string, unknown> =>
      !!value && typeof value === 'object' && !Array.isArray(value)
  );
  const from = nested ?? raw;
  const kindWord =
    word(nested ? (from.k ?? from.kind ?? from.type) : undefined) ||
    word(raw.set) ||
    word(raw.src) ||
    word(raw.source);
  const k = SET_KINDS[kindWord];
  const q = [from.q, from.of, from.query, from.name, from.search, raw.of].find(
    (value): value is string =>
      typeof value === 'string' && !!value.trim() && value.length <= 100
  );
  if (!k || !q) {
    return null;
  }
  const roleWord =
    word(nested ? (from.r ?? from.role) : undefined) || word(raw.role);
  const r =
    kindWord === 'director' || /direct/.test(roleWord)
      ? 'director'
      : ['actor', 'actress', 'cast'].includes(kindWord) ||
          /cast|act|star/.test(roleWord)
        ? 'cast'
        : null;
  return { k, q: q.trim(), r };
};

const chatReply = z
  .object({
    r: text(400).default(''),
    titles: z.array(namedTitle).max(CHAT_TITLES_MAX).default([]),
    /**
     * Put the titles on a list, or request them: offered, never done. Or
     * fix something about a title on the server: done at once. Or, for an
     * admin, hand a change to the admin agent, which proposes it for them
     * to approve.
     */
    do: z.enum(['list', 'request', 'fix', 'admin']).nullish().catch(null),
    /** For "fix": what to fix, where, and the subtitle language. */
    fx: z.enum(FIX_KINDS).nullish().catch(null),
    se: z.coerce.number().int().min(0).max(500).nullish().catch(null),
    ep: z.coerce.number().int().min(0).max(5000).nullish().catch(null),
    lang: z
      .string()
      .regex(/^[a-z]{2}$/i)
      .nullish()
      .catch(null),
    /** The list's name, for "list". */
    n: text(80).nullish().catch(null),
    /** Films, series, or both, for a set. */
    m: z.enum(['movie', 'tv', 'any']).nullish().catch(null),
  })
  .passthrough()
  .transform(({ r, titles, do: action, n, m, fx, se, ep, lang, ...rest }) => ({
    r,
    titles,
    do: action,
    n,
    m,
    fx,
    se,
    ep,
    lang: lang?.toLowerCase(),
    /** A whole set of titles to read from TMDB instead of naming them. */
    src: readSet(rest),
  }));

/**
 * A title's name for comparing, without the year or "(series)" and ignoring
 * case and punctuation: "The Office (2005)" and "the office (series)" match.
 */
const nameKey = (name: string) =>
  name
    .replace(/\s*\((?:series|\d{4})\)\s*$/i, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** What the model is told about someone's watching, and how to read it. */
const historyNote = (activity: Activity) => {
  switch (activity.source) {
    case 'watched':
      return `Watch history, newest first: ${activity.items
        .slice(0, 8)
        .map((item) =>
          item.at === undefined
            ? item.name
            : `${item.name.replace(/\)$/, '')}${
                item.name.endsWith(')') ? ', ' : ' ('
              }${ago(item.at)})`
        )
        .join('; ')}`;
    case 'requested':
      return `No watch history can be seen. Recently requested, newest first: ${activity.items
        .slice(0, 8)
        .map((item) => item.name)
        .join('; ')}`;
    default:
      return 'No watch history can be seen.';
  }
};

/**
 * What the model is told when a picture comes with the message: a poster, a
 * screen, a cover or someone's message, and the titles in it are what is
 * wanted unless the message says otherwise.
 */
const PICTURE_NOTE =
  'A picture is attached. It may show a poster, a DVD or Blu-ray cover, a TV, cinema or phone screen, a streaming app, a ticket, a magazine or a message naming titles. ' +
  'Put every film or series it shows or names in "titles", most prominent first; for a scene or a still, the title it is from, if you can tell. ' +
  'Read the names from the picture as written and give the year when it shows one. If you cannot tell what it is, say so in "r" and give no titles; never guess a title the picture does not support. ' +
  'With no message, or a message such as "this" or "what is this", they want the titles found; "request this" or "add this to a list" sets "do" as usual. ';

/**
 * What an admin's AI Search may hand to the admin agent: changes to what is
 * on the server, which the agent works out and proposes, and which happen
 * only once the admin approves them on the agent's page.
 */
const ADMIN_NOTE =
  'They are an admin. If they ask to change what is on the server beyond the fixes below (replace a file with a better or different release, block or unblock a release group, mark a download as failed, delete a title\'s files, move a title to another quality profile, search for a better release), add "do":"admin" with the one title in "titles" (none when it is only about a release group). Say in "r" that the admin agent is on it and that nothing changes until they approve. ';

/** An admin's change, handed to the admin agent; where to follow it. */
const toAgent = async (
  user: User,
  message: string,
  said: string,
  titles: NamedTitle[]
) => {
  const named = titles[0];
  const about = named
    ? ` (The title: ${named.t}${named.y ? ` (${named.y})` : ''}${
        named.k ? `, a ${named.k === 'tv' ? 'series' : 'movie'}` : ''
      }.)`
    : '';
  try {
    const run = await agent.ask(`${clip(message.trim(), 900)}${about}`, user);
    return {
      reply:
        said ||
        'The admin agent is on it. It will show you what it would change, and nothing changes until you approve.',
      results: [],
      fix: { kind: 'agent', ok: true, link: `/backfill/agent/${run.id}` },
    };
  } catch (e) {
    return {
      reply: `The admin agent cannot take this now: ${
        e instanceof Error ? e.message : String(e)
      }`,
      results: [],
      fix: { kind: 'agent', ok: false },
    };
  }
};

export const chat = async (
  user: User,
  message: string,
  turns: ChatTurn[],
  sent?: CompletionImage
) => {
  // Shrunk to the budget first, so the same photo is the same question.
  const image = sent && (await preparePhoto(sent));
  const history = historyNote(await recentActivity(user));
  // The last few turns word for word, so "yes" or "no, the older one" makes
  // sense; older ones cost tokens and rarely matter.
  const earlier = turns
    .slice(-3)
    .map((turn) =>
      [
        `Person: ${clip(turn.ask, 200)}`,
        turn.reply ? `You: ${clip(turn.reply, 200)}` : '',
        turn.offered.length
          ? `You offered: ${turn.offered.slice(0, 6).join('; ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    )
    .join('\n');
  // Everything offered so far in the conversation, never offered again.
  const offered = [
    ...new Set(turns.flatMap((turn) => turn.offered.slice(0, 8))),
  ].slice(-30);
  const prompt = [
    history,
    earlier ? `Earlier:\n${earlier}` : '',
    offered.length ? `Already offered: ${offered.join('; ')}` : '',
    message.trim()
      ? `Message: ${clip(message, 500)}`
      : 'Message: (none, only the picture)',
  ]
    .filter(Boolean)
    .join('\n\n');

  const admin = user.hasPermission(Permission.ADMIN);
  const answer = await askAiJson(chatReply, {
    feature: 'aiChat',
    user,
    image,
    system:
      'You help someone find films and TV series for their home media server. ' +
      (image ? PICTURE_NOTE : '') +
      'The watch history is theirs, newest first: its first entry is what they "just watched" or "last watched". Use it to answer questions about what they watched and to understand "like what I watched". It is not a list of suggestions. ' +
      'Answer, do not ask: always give your best titles, and if a request could mean more than one thing, go with the likeliest and say in "r" what you went with, e.g. "Lighter shows in the spirit of Survivor:". ' +
      'When they say yes, more, or agree, give new titles that fit what was discussed, never one already offered. ' +
      'A question that is not a search, such as what they last watched, is answered in "r", with no titles unless they help. ' +
      'Only if there is no watch history and they refer to it, say so and ask what it was. ' +
      'If they want titles put on a list (a new one to make, or one of theirs they name), add "do":"list" and the list\'s name in "n" (for a new list, a short name that fits). If they want titles requested or downloaded, add "do":"request". When that is about titles already offered ("those", "all of them"), leave "titles" empty; if they pick only some, list just those. You only set this up: they confirm it themselves. ' +
      'For a whole set, do not list titles: name the set and every title is read from TMDB. Use "set": "series" for a film series (Harry Potter, John Wick), "universe" for a shared universe or theme (Marvel Cinematic Universe), "studio" for a studio\'s films (Pixar, A24), "director" or "actor" for someone\'s films; "of": the name to search for; "m": "movie", "tv" or "any". For example, "request all of Nolan\'s films" is {"r":"Christopher Nolan\'s films as director.","titles":[],"do":"request","set":"director","of":"Christopher Nolan","m":"movie"}. ' +
      (admin ? ADMIN_NOTE : '') +
      'If they report a problem with a title on the server or ask for something done to it, add "do":"fix" with "fx": "subtitles" (get or replace subtitles), "transcribe" (make subtitles from the audio), "missing" (find missing or lost episodes, or a movie that never arrived), "broken" (will not play, corrupt, no sound, bad quality) or "wrongEpisode" (an episode is the wrong one, or episodes are mixed up); the one title in "titles"; "se" and "ep" for the season and episode when given; "lang" as a two-letter code for a subtitle language. "This episode" or "it" means the title just discussed. Say in "r" what will be done. ' +
      'Reply with JSON only: {"r":"one or two short sentences","titles":[{"t":"title","y":first release year or null,"k":"movie" or "tv"}]}, plus "do", "n", "set", "of" and "m" when they apply. Up to 6 titles, best first; up to 20 when they ask for a list.',
    prompt,
    maxTokens: 700,
    cache: {
      key: cacheKey(
        user.id,
        history,
        earlier,
        offered,
        message.trim().toLowerCase(),
        image ? createHash('sha256').update(image.data).digest('base64url') : ''
      ),
      ms: HOUR,
    },
  });

  if (answer.do === 'admin' && admin) {
    return toAgent(user, message, answer.r, answer.titles as NamedTitle[]);
  }

  if (answer.do === 'fix') {
    if (!answer.fx) {
      return {
        reply:
          'What is wrong with it: subtitles, missing episodes, a file that will not play, or the wrong episode?',
        results: [],
      };
    }
    // The issue's first comment is what they wrote; a photo alone says so.
    return fixFromChat(user, message.trim() || 'Reported with a photo.', {
      kind: answer.fx,
      title: (answer.titles as NamedTitle[])[0],
      seasonNumber: answer.se ?? undefined,
      episodeNumber: answer.ep ?? undefined,
      language: answer.lang,
    });
  }

  // A whole set: read from TMDB, complete, rather than from the model.
  if (answer.src) {
    const set = await titlesFromSource(user, answer.src, answer.m ?? 'movie');
    if (!set || !set.results.length) {
      return {
        reply: `TMDB has nothing for “${clip(answer.src.q, 60)}”. Try naming it another way.`,
        results: [],
      };
    }
    return {
      reply: answer.r,
      results: set.results,
      source: { name: set.name, more: set.more },
      ...((answer.do === 'list' || answer.do === 'request') && {
        action: {
          do: answer.do,
          name: answer.n ?? set.name,
          earlier: false,
        },
      }),
    };
  }

  // A title already offered is not shown again, however the model answers,
  // unless it is being put on a list or requested: then the person named it
  // again on purpose. (What they watched stays findable: "that island show
  // I was watching" should find it.)
  const action =
    answer.do === 'list' || answer.do === 'request' ? answer.do : undefined;
  // Asked to list or request, with no titles, no set and nothing offered
  // before to mean: say what would work rather than show nothing.
  if (action && !answer.titles.length && !offered.length) {
    logger.info('AI chat could not tell which titles were meant', {
      label: 'AI',
      feature: 'aiChat',
    });
    return {
      reply:
        'I could not tell which titles you mean. Name the series, universe, studio or person, e.g. “all films directed by Christopher Nolan” or “every Pixar film”.',
      results: [],
    };
  }
  const hidden = new Set(action ? [] : offered.map(nameKey));
  const results = (
    await resolveTitles(
      user,
      (answer.titles as NamedTitle[]).filter(
        (title) => !hidden.has(nameKey(title.t))
      )
    )
  ).filter(
    (result) =>
      !hidden.has(
        nameKey(
          ('title' in result ? result.title : undefined) ??
            ('name' in result ? result.name : undefined) ??
            ''
        )
      )
  );

  // Only repeats, or titles that do not exist: say so rather than leave a
  // "here are some more" with nothing under it.
  const reply =
    answer.titles.length && !results.length && !action
      ? 'Nothing new turned up for that. Try describing it another way.'
      : answer.r;

  return {
    reply,
    results,
    ...(action && {
      action: {
        do: action,
        ...(answer.n && { name: answer.n }),
        // No titles of its own: it means what was offered before.
        earlier: !answer.titles.length,
      },
    }),
  };
};

// ---- why each suggestion was suggested ------------------------------------

const PAGE = 20;
const reasonsReply = z.object({ r: z.array(text(200)).max(PAGE * 2) });

export const suggestionReasons = async (
  user: User,
  page: number,
  mediaType?: 'movie' | 'tv'
) => {
  // The same list, and order, as the page being explained.
  const all = (await getSuggestions(user)).filter(
    (result) => !mediaType || result.media_type === mediaType
  );
  const items = all.slice((page - 1) * PAGE, page * PAGE);
  if (!items.length) {
    return [];
  }
  const watching = await recentWatching(user, 10);
  if (!watching.length) {
    throw new AiError('There is no watch history to explain these by.', 409);
  }
  const list = items.map((item, i) => `${i + 1}. ${label(item)}`).join('\n');

  const answer = await askAiJson(reasonsReply, {
    feature: 'aiReasons',
    user,
    system:
      'For each numbered title, say in at most 15 words why someone who watched the listed titles would like it. Name what connects them; no spoilers, no filler. ' +
      'Reply with JSON only: {"r":["reason for 1","reason for 2",...]} in list order.',
    prompt: `Watched: ${watching.join('; ')}\n\nSuggested:\n${list}`,
    maxTokens: 45 * items.length + 40,
    cache: { key: cacheKey(user.id, watching, list), ms: DAY },
  });

  return items.map((item, i) => ({
    tmdbId: item.id,
    mediaType: item.media_type,
    reason: answer.r[i] ?? '',
  }));
};

// ---- picking for a room of people -----------------------------------------

/**
 * Who someone may include in a pick: people they share a watch list with,
 * who have not turned picks off. What someone watches is otherwise theirs
 * (and admins') to see, so sharing a list is the line. A list counts once
 * the person it was shared with has accepted it: anyone can add anyone to
 * a list, and that alone is not agreeing to share their history. Admins
 * may include anyone.
 */
const pickableIds = async (caller: User): Promise<number[]> => {
  if (caller.hasPermission(Permission.ADMIN)) {
    return (await getRepository(User).find({ select: { id: true } }))
      .map((u) => u.id)
      .filter((id) => id !== caller.id);
  }
  const mine = [
    ...(
      await getRepository(MediaList).find({
        select: { id: true },
        where: { ownerId: caller.id },
      })
    ).map((l) => l.id),
    ...(
      await getRepository(MediaListMember).find({
        where: { userId: caller.id },
      })
    )
      .filter((m) => m.acceptedAt)
      .map((m) => m.listId),
  ];
  if (!mine.length) {
    return [];
  }
  const [owners, members] = await Promise.all([
    getRepository(MediaList).find({
      select: { ownerId: true },
      where: { id: In(mine) },
    }),
    getRepository(MediaListMember).find({ where: { listId: In(mine) } }),
  ]);
  return [
    ...new Set([
      ...owners.map((l) => l.ownerId),
      ...members.filter((m) => m.acceptedAt).map((m) => m.userId),
    ]),
  ].filter((id) => id !== caller.id);
};

export const pickablePeople = async (caller: User) => {
  const ids = await pickableIds(caller);
  if (!ids.length) {
    return [];
  }
  const users = await getRepository(User).find({
    where: { id: In(ids) },
    relations: { settings: true },
  });
  // By name, ignoring case and accents, so someone is found where expected.
  const byName = new Intl.Collator(undefined, {
    sensitivity: 'base',
    numeric: true,
  });
  return users
    .filter((u) => featureEnabled('aiPicker', u))
    .map((u) => ({ id: u.id, displayName: u.displayName, avatar: u.avatar }))
    .sort((a, b) => byName.compare(a.displayName, b.displayName));
};

const pickReply = z.object({
  p: z.array(z.object({ n: z.number().int().min(1), w: text(240) })).max(6),
});

export const pickForRoom = async (
  caller: User,
  options: {
    people: number[];
    kind: 'movie' | 'tv' | 'any';
    mood?: string;
    availableOnly: boolean;
  }
) => {
  const allowed = new Set(await pickableIds(caller));
  const ids = [
    caller.id,
    ...[...new Set(options.people)].filter((id) => allowed.has(id)),
  ].slice(0, 6);
  const people = await getRepository(User).find({
    where: { id: In(ids) },
    relations: { settings: true },
  });
  const included = people.filter(
    (p) => p.id === caller.id || featureEnabled('aiPicker', p)
  );

  // Candidates: what each person's own suggestions point to, ranked so a
  // title several of them would like comes first.
  const score = new Map<
    string,
    { result: Awaited<ReturnType<typeof getSuggestions>>[number]; s: number }
  >();
  // People are "Viewer1", "Viewer2" to the model, never their names or
  // emails; the names go back in when the reasons come back.
  const tastes: string[] = [];
  const names = new Map<string, string>();
  for (const person of included) {
    const [suggested, watching] = await Promise.all([
      getSuggestions(person),
      recentWatching(person, 6),
    ]);
    if (watching.length) {
      const alias = `Viewer${names.size + 1}`;
      names.set(alias, person.displayName);
      tastes.push(`${alias}: ${watching.join('; ')}`);
    }
    suggested.forEach((result, rank) => {
      if (options.kind !== 'any' && result.media_type !== options.kind) {
        return;
      }
      const key = `${result.media_type}:${result.id}`;
      const entry = score.get(key) ?? { result, s: 0 };
      entry.s += 1 + (100 - Math.min(rank, 99)) / 100;
      score.set(key, entry);
    });
  }
  if (!tastes.length) {
    throw new AiError(
      'Nobody chosen has any watch history to pick from yet.',
      409
    );
  }

  let ranked = [...score.values()].sort((a, b) => b.s - a.s);
  const media = await Media.getRelatedMedia(
    caller,
    ranked.map((c) => ({
      tmdbId: c.result.id,
      mediaType:
        c.result.media_type === 'movie' ? MediaType.MOVIE : MediaType.TV,
    }))
  );
  const statusOf = (c: (typeof ranked)[number]) =>
    media.find(
      (m) =>
        m.tmdbId === c.result.id &&
        m.mediaType ===
          (c.result.media_type === 'movie' ? MediaType.MOVIE : MediaType.TV)
    );
  if (options.availableOnly) {
    ranked = ranked.filter((c) =>
      [MediaStatus.AVAILABLE, MediaStatus.PARTIALLY_AVAILABLE].includes(
        statusOf(c)?.status ?? MediaStatus.UNKNOWN
      )
    );
  }
  const candidates = ranked.slice(0, 40);
  if (!candidates.length) {
    throw new AiError(
      options.availableOnly
        ? 'Nothing in the library matches yet. Try including titles not in the library.'
        : 'There is nothing to pick from yet.',
      409
    );
  }

  const list = candidates
    .map(
      (c, i) =>
        `${i + 1}. ${label(c.result)}${c.result.media_type === 'tv' ? ' [series]' : ''}`
    )
    .join('\n');
  const mood = options.mood ? clip(options.mood, 150) : '';

  const answer = await askAiJson(pickReply, {
    feature: 'aiPicker',
    user: caller,
    system:
      'Choose the 3 numbered titles this group would most enjoy together, from their recent watching' +
      (mood ? ' and the mood asked for' : '') +
      '. Only choose from the list. For each, give a reason of at most 20 words naming who it suits (by their ViewerN name) and why. ' +
      'Reply with JSON only: {"p":[{"n":number,"w":"reason"}]}.',
    prompt: `Group:\n${tastes.join('\n')}${mood ? `\n\nMood: ${mood}` : ''}\n\nTitles:\n${list}`,
    maxTokens: 260,
    cache: { key: cacheKey(ids, tastes, list, mood), ms: 6 * HOUR },
  });

  return answer.p
    .filter((p) => p.n >= 1 && p.n <= candidates.length)
    .filter((p, i, all) => all.findIndex((q) => q.n === p.n) === i)
    .map((p) => {
      const c = candidates[p.n - 1];
      const related = statusOf(c);
      return {
        reason: p.w.replace(/Viewer\d+/g, (alias) => names.get(alias) ?? alias),
        result:
          c.result.media_type === 'movie'
            ? mapMovieResult(c.result, related)
            : mapTvResult(c.result, related),
      };
    });
};

// ---- catching up on a series ----------------------------------------------

export interface Position {
  season: number;
  episode: number;
}

/**
 * Where a recap should stop: just before the next episode this person has
 * not seen, from their watch history. Null when there is no telling.
 */
export const recapPosition = async (
  user: User,
  tvId: number
): Promise<Position | null> => {
  const progress = (await getSeriesProgress(user, [tvId]))[tvId];
  // Just after the furthest episode finished, not the next one in the
  // library: with a gap in the library, that would recap an episode they
  // have not seen.
  return progress?.furthest
    ? {
        season: progress.furthest.season,
        episode: progress.furthest.episode + 1,
      }
    : null;
};

/**
 * A spoiler-free "previously on", up to (not including) an episode. Built
 * from TMDB's own synopses: whole seasons as a line each, and the current
 * season episode by episode, so nothing past the stopping point is sent.
 */
export const recap = async (user: User, tvId: number, upTo: Position) => {
  const tmdb = new TheMovieDb();
  const show = await tmdb.getTvShow({ tvId });
  const seasons = (show.seasons ?? [])
    .filter((s) => s.season_number >= 1 && s.season_number <= upTo.season)
    .sort((a, b) => a.season_number - b.season_number);
  if (!seasons.length || (upTo.season === 1 && upTo.episode <= 1)) {
    throw new AiError('There is nothing before this episode to recap.', 400);
  }

  const lines: string[] = [];
  // Seasons long past get their summary only; the most recent full season
  // and the current one get episode detail, which is what jogs memory.
  for (const season of seasons) {
    const current = season.season_number === upTo.season;
    const recent = season.season_number === upTo.season - 1;
    if (!current && !recent) {
      if (season.overview) {
        lines.push(
          `Season ${season.season_number}: ${clip(season.overview, 400)}`
        );
      }
      continue;
    }
    const detail = await tmdb.getTvSeason({
      tvId,
      seasonNumber: season.season_number,
    });
    const episodes = (detail.episodes ?? []).filter(
      (ep) => !current || ep.episode_number < upTo.episode
    );
    if (!episodes.length) {
      continue;
    }
    lines.push(
      `Season ${season.season_number}:\n${episodes
        .map(
          (ep) =>
            `E${ep.episode_number} ${ep.name}: ${clip(ep.overview || '', 220)}`
        )
        .join('\n')}`
    );
  }
  if (!lines.length) {
    throw new AiError('TMDB has no episode summaries for this series.', 409);
  }

  const text = await askAi({
    feature: 'aiRecap',
    user,
    system:
      'Write a spoiler-free "previously on" recap from the synopses given, for someone about to watch the next episode. ' +
      'Use only what is given: nothing after it, no guesses about what comes next. About 150 words, plain text, most recent events in the most detail.',
    prompt: `${show.name}, before season ${upTo.season} episode ${upTo.episode}:\n\n${lines.join('\n\n')}`,
    maxTokens: 400,
    // Not personal: the same stopping point gives the same recap to anyone.
    cache: { key: cacheKey(tvId, upTo.season, upTo.episode), ms: 30 * DAY },
  });
  return { text, upTo };
};

// ---- a second look at what Maintainerr is about to delete ------------------

const reviewReply = z.object({
  f: z.array(z.object({ n: z.number().int().min(1), w: text(240) })).max(25),
});

export const reviewDeletions = async (user: User) => {
  const due = (await getDeletingSoon())
    .sort(
      (a, b) => new Date(a.deleteAt).getTime() - new Date(b.deleteAt).getTime()
    )
    .slice(0, 25);
  if (!due.length) {
    return [];
  }

  const tmdb = new TheMovieDb();
  const now = Date.now();
  const days = (date: Date | number) =>
    Math.max(0, Math.round((now - new Date(date).getTime()) / DAY));

  const facts = await mapWithConcurrency(due, 3, async (item, i) => {
    const media = await getRepository(Media).findOne({
      where: { tmdbId: item.tmdbId, mediaType: item.mediaType },
    });
    const [details, watched, lists, request] = await Promise.all([
      (item.mediaType === MediaType.MOVIE
        ? tmdb.getMovie({ movieId: item.tmdbId })
        : tmdb.getTvShow({ tvId: item.tmdbId })
      ).catch(() => null),
      media ? getWatchedBy(media).catch(() => undefined) : undefined,
      media
        ? getRepository(MediaListItem).count({
            where: { tmdbId: item.tmdbId, mediaType: item.mediaType },
          })
        : 0,
      media
        ? getRepository(MediaRequest).findOne({
            where: { media: { id: media.id } },
            order: { createdAt: 'DESC' },
          })
        : null,
    ]);
    const name = details ? label(details) : `TMDB ${item.tmdbId}`;
    const parts = [
      `${i + 1}. ${name}${item.mediaType === MediaType.TV ? ' [series]' : ''}`,
      `deletes in ${Math.max(0, Math.round((new Date(item.deleteAt).getTime() - now) / DAY))}d`,
      request ? `requested ${days(request.createdAt)}d ago` : 'never requested',
      media ? `added ${days(media.createdAt)}d ago` : '',
      lists ? `on ${lists} watch list${lists === 1 ? '' : 's'}` : '',
      watched === undefined
        ? ''
        : watched.length
          ? `watched by ${watched.length} (${watched
              .slice(0, 4)
              .map(
                (w) =>
                  `${w.count} ${item.mediaType === MediaType.TV ? 'eps' : 'plays'}${
                    w.lastWatched
                      ? `, last ${days(new Date(w.lastWatched))}d ago`
                      : ''
                  }`
              )
              .join('; ')})`
          : 'never watched',
    ];
    return { item, name, line: parts.filter(Boolean).join(', ') };
  });

  const answer = await askAiJson(reviewReply, {
    feature: 'aiDeletionReview',
    user,
    system:
      'A media server is about to delete these titles under automatic rules. Flag only the ones deleting may be a mistake: someone part-way through a series, rewatched often or recently, recently requested or added, or on watch lists. ' +
      'At most 8 flags, the strongest first, at most 20 words each naming the evidence. Reply with JSON only: {"f":[{"n":number,"w":"why"}]}, or {"f":[]} if none.',
    prompt: facts.map((f) => f.line).join('\n'),
    maxTokens: 45 * Math.min(due.length, 8) + 60,
    cache: { key: cacheKey(facts.map((f) => f.line)), ms: 6 * HOUR },
  });

  return answer.f
    .filter((f) => f.n >= 1 && f.n <= facts.length)
    .filter((f, i, all) => all.findIndex((g) => g.n === f.n) === i)
    .map((f) => {
      const fact = facts[f.n - 1];
      return {
        tmdbId: fact.item.tmdbId,
        mediaType: fact.item.mediaType,
        title: fact.name,
        deleteAt: fact.item.deleteAt,
        canKeep: fact.item.canKeep,
        reason: f.w,
      };
    });
};

// ---- a likely fix for a reported problem ----------------------------------

export const triageIssue = async (user: User, issueId: number) => {
  const issue = await getRepository(Issue).findOne({
    where: { id: issueId },
    relations: { media: true, comments: true },
  });
  if (!issue) {
    throw new AiError('Issue not found.', 404);
  }
  const tmdb = new TheMovieDb();
  const details = await (
    issue.media.mediaType === MediaType.MOVIE
      ? tmdb.getMovie({ movieId: issue.media.tmdbId })
      : tmdb.getTvShow({ tvId: issue.media.tmdbId })
  ).catch(() => null);

  const comments = [...(issue.comments ?? [])]
    .sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    )
    .slice(-5)
    .map((c) => `- ${clip(c.message, 200)}`)
    .join('\n');

  // What fixed earlier problems with the same title, if anything.
  const earlier = await getRepository(Issue).find({
    where: {
      media: { id: issue.media.id },
      status: IssueStatus.RESOLVED,
    },
    relations: { comments: true },
    order: { updatedAt: 'DESC' },
    take: 4,
  });
  const history = earlier
    .filter((e) => e.id !== issue.id)
    .slice(0, 3)
    .map((e) => {
      const last = [...(e.comments ?? [])].sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )[0];
      return `- ${IssueTypeName[e.issueType]} issue, resolved${last ? `: ${clip(last.message, 150)}` : ''}`;
    })
    .join('\n');

  const where =
    issue.media.mediaType === MediaType.TV && issue.problemSeason
      ? ` S${issue.problemSeason}${issue.problemEpisode ? `E${issue.problemEpisode}` : ''}`
      : '';
  const prompt = [
    `${details ? label(details) : 'A title'}${where}: ${IssueTypeName[issue.issueType]} problem.`,
    comments ? `Report and replies:\n${comments}` : '',
    history ? `Earlier problems with this title:\n${history}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const text = await askAi({
    feature: 'aiIssueTriage',
    user,
    system:
      'You help the admin of a Plex or Jellyfin server with Radarr and Sonarr fix a reported playback problem. ' +
      'Give the most likely cause in one sentence, then up to 3 short numbered steps to fix it (for example: search for a different release, check the audio track or subtitle file, check the client). Under 110 words, plain text.',
    prompt,
    maxTokens: 260,
    cache: { key: cacheKey(prompt), ms: 7 * DAY },
  });
  return { text };
};

// ---- what a log entry means -----------------------------------------------

/** Values that look like secrets never leave the server. */
const SECRET_KEY =
  /(token|key|secret|password|passwd|pwd|auth|cookie|session|credential|signature)/i;

const SECRET_TEXT: [RegExp, string][] = [
  // user:password@ in an address.
  [/(\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1[redacted]@'],
  // Authorization headers of any kind.
  [/\b(bearer|basic|token)\s+[\w\-.~+/]+=*/gi, '$1 [redacted]'],
  // name=value, name: value and "name":"value" for anything secret-sounding,
  // in addresses, headers, or JSON inside a string.
  [
    /(["']?[\w-]*(?:token|key|secret|password|passwd|pwd|auth|cookie|session|signature)[\w-]*["']?\s*[=:]\s*["']?)[^\s"'&,;}]+/gi,
    '$1[redacted]',
  ],
  // Long opaque strings: API keys and tokens, including Plex's 20 characters.
  [/\b[A-Za-z0-9_-]{20,}\b/g, '[redacted]'],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]'],
];

export const redact = (value: unknown, depth = 0): unknown => {
  if (depth > 4) {
    return '…';
  }
  if (typeof value === 'string') {
    return SECRET_TEXT.reduce(
      (text, [pattern, replacement]) => text.replace(pattern, replacement),
      value
    );
  }
  if (Array.isArray(value)) {
    return value.slice(0, 10).map((v) => redact(v, depth + 1));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 20)
        .map(([k, v]) => [
          k,
          SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1),
        ])
    );
  }
  return value;
};

export const explainLog = async (
  user: User,
  entry: { label?: string; level?: string; message: string; data?: unknown }
) => {
  const data = entry.data ? clip(JSON.stringify(redact(entry.data)), 800) : '';
  const prompt = `[${entry.level ?? 'error'}] [${entry.label ?? 'Seerr'}] ${clip(
    redact(entry.message) as string,
    600
  )}${data ? `\nDetails: ${data}` : ''}`;

  const text = await askAi({
    feature: 'aiLogs',
    user,
    system:
      'Explain this log entry from Seerr (a media request app working with Plex or Jellyfin, Radarr, Sonarr and TMDB) to its admin: what happened in one or two plain sentences, and the most likely thing to check or change. Under 90 words. Say so if it is harmless.',
    prompt,
    maxTokens: 200,
    cache: { key: cacheKey(prompt), ms: 7 * DAY },
  });
  return { text };
};
