import { MediaType } from '@server/constants/media';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { ChangeInput } from '@server/lib/agent/changes';
import {
  ChangeError,
  describeChange,
  describeSeasonReplace,
} from '@server/lib/agent/changes';
import { deleteProblem } from '@server/lib/agent/rules';
import type {
  AgentState,
  AgentTool,
  TitleRef,
} from '@server/lib/agent/tools/base';
import {
  ToolError,
  mayReplace,
  readTitleRef,
  replaceReported,
} from '@server/lib/agent/tools/base';
import { lookups, nameOf } from '@server/lib/agent/tools/titles';
import backfill from '@server/lib/backfill/engine';
import { baseName } from '@server/lib/backfill/naming';
import { relinkEpisodeFile } from '@server/lib/backfill/relink';
import { musicReady } from '@server/lib/music/access';
import { z } from 'zod';

/*
 * Asking an admin, and what it does only with one in the conversation
 * or for a report asking for it: relinking a file, proposing changes,
 * replacing a season, searching for an upgrade, requesting a title.
 */

export const askAdmin: AgentTool = {
  name: 'ask_admin',
  description:
    'Asks the admin something and pauses until they answer. Only when you truly cannot decide yourself (two different versions and no way to tell which is wanted, say). The answer comes as the next message.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'Plainly, with the choices.' },
    },
    required: ['question'],
  },
  async run(state, input) {
    const { question } = z
      .object({ question: z.string().trim().min(3).max(1500) })
      .parse(input);
    state.ask(question);
    return 'The admin has been asked. Stop here and wait for their answer.';
  },
};

export const relinkFile: AgentTool = {
  name: 'relink_file',
  // It changes what Sonarr has on file, from what a file's name and length
  // suggest: only with an admin in the conversation to see it done.
  askOnly: true,
  description:
    'Fixes a file already imported that holds several episodes (S06E01-02) but that Sonarr links to only one, so the others look missing and Plex shows one: links the file to every episode it holds and has Sonarr rename it (S06E01-E02). Give the season and every episode the file holds, in a row; the file is the one on the first of them that has one. The others must have no file of their own. Nothing is downloaded, moved or deleted.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'A series reference.' },
      season: { type: 'integer' },
      episodes: {
        type: 'array',
        items: { type: 'integer' },
        description: 'Every episode the file holds, like [1, 2].',
      },
      reason: {
        type: 'string',
        description: 'How you know the file holds these episodes.',
      },
    },
    required: ['title', 'season', 'episodes', 'reason'],
  },
  async run(state, input) {
    const args = z
      .object({
        season: z.coerce.number().int().min(0),
        episodes: z.array(z.coerce.number().int().min(0)).min(2).max(10),
        reason: z.string().trim().min(3).max(600),
      })
      .parse(input);
    const title = readTitleRef(input.title);
    if (title.kind !== 'series') {
      throw new ToolError('Only an episode file can be relinked.');
    }
    const sonarr = backfill.sonarrFor(title.serverId);
    const result = await relinkEpisodeFile(
      sonarr,
      title.arrId,
      args.season,
      args.episodes
    ).catch((e: unknown) => {
      throw new ToolError(e instanceof Error ? e.message : String(e));
    });
    const name = (await sonarr.getSeriesDetail(title.arrId)).title;
    if (!result.changed) {
      return `"${baseName(result.from)}" is already linked to ${result.episodes}; nothing changed.`;
    }
    state.bind(title, name);
    state.act({
      at: new Date().toISOString(),
      type: 'relink',
      title: name,
      detail: `Linked "${baseName(result.from)}" to ${result.episodes}${
        result.to !== result.from ? `, renamed "${baseName(result.to)}"` : ''
      }: ${args.reason}`,
    });
    return result.to === result.from
      ? `The file "${baseName(result.from)}" is linked to ${result.episodes}. Sonarr kept its name.`
      : `Linked to ${result.episodes} and renamed: "${baseName(result.from)}" is now "${baseName(result.to)}". Plex picks the new name up at its next scan.`;
  },
};

// ---- an admin's changes --------------------------------------------------------

const CHANGE_KINDS = [
  'blockGroup',
  'unblockGroup',
  'markFailed',
  'deleteFiles',
  'changeProfile',
] as const;

export const proposeChange: AgentTool = {
  name: 'propose_change',
  askOnly: true,
  description:
    "Puts a change to the admin, who approves or declines it; nothing happens until they approve. Only for what the admin asked for. blockGroup / unblockGroup: a release group (group) that Backfill, you, Radarr and Sonarr then pass over; a file already on disk from it is replaced by the next good release. markFailed: a title's current download (or a movie's last grab) is removed and blocklisted, and Radarr or Sonarr searches again. deleteFiles: a movie's file, or a series' files (all, a season, or some of its episodes), only when deleting is what the admin asked for, never to replace them (that is replace_season, or grab with replace: true); unmonitor: true also stops them being downloaded again. changeProfile: moves a title to another quality profile (profile, by name); search: true searches right after. Several changes may be proposed in one turn; the admin sees them together.",
  parameters: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: [...CHANGE_KINDS] },
      title: {
        type: 'string',
        description: 'A title reference; not for blockGroup or unblockGroup.',
      },
      group: { type: 'string', description: 'A release group, like FLUX.' },
      season: { type: 'integer' },
      episodes: { type: 'array', items: { type: 'integer' } },
      profile: { type: 'string', description: 'A quality profile, by name.' },
      unmonitor: { type: 'boolean' },
      search: { type: 'boolean' },
      reason: {
        type: 'string',
        description: "Why, in the admin's terms: shown to them with it.",
      },
    },
    required: ['kind', 'reason'],
  },
  async run(state, input) {
    const args = z
      .object({
        kind: z.enum(CHANGE_KINDS),
        title: z.string().optional(),
        group: z.string().trim().max(60).optional(),
        season: z.coerce.number().int().min(0).optional(),
        episodes: z.array(z.coerce.number().int().min(0)).max(200).optional(),
        profile: z.string().trim().max(100).optional(),
        unmonitor: z.boolean().optional(),
        search: z.boolean().optional(),
        reason: z.string().trim().min(3).max(600),
      })
      .parse(input);
    const groupChange =
      args.kind === 'blockGroup' || args.kind === 'unblockGroup';
    let title: TitleRef | undefined;
    let name: string | undefined;
    if (!groupChange) {
      title = readTitleRef(args.title);
      if (title.kind === 'album') {
        throw new ToolError(
          'For an album only blockGroup and unblockGroup can be proposed. A bad track is replaced with grab and replace: true; Lidarr does the rest.'
        );
      }
      name = await nameOf(title);
    }
    if (args.kind === 'deleteFiles') {
      const problem = deleteProblem([
        state.run.ask ?? '',
        ...state.run.steps
          .filter((step) => step.kind === 'reply')
          .map((step) => step.text),
        ...(replaceReported(state.run) ? ['replace'] : []),
      ]);
      if (problem) throw new ToolError(problem);
    }
    const change: ChangeInput = { ...args, title, name };
    const proposed = await describeChange(change).catch((e: unknown) => {
      throw e instanceof ChangeError ? new ToolError(e.message) : e;
    });
    if (title && name) state.bind(title, name);
    state.propose(proposed);
    return `Proposed: ${proposed.headline}. The admin approves or declines it; stop here, and you hear what they decided next.`;
  },
};

export const replaceSeason: AgentTool = {
  name: 'replace_season',
  description:
    "Replaces every file of one season of a series, when the admin (or the report) says the whole season is bad or wants it replaced or downloaded again. It searches Sonarr for the season and picks a release none of the current files came from: a season pack Sonarr accepts first, otherwise one release per episode, in English or the series' own language. It is put to the admin to approve; then the new release is grabbed first, and only after that are the old releases marked failed in Sonarr (never taken again) and the old files removed so the new ones import. Nothing is removed if nothing could be grabbed. Use this, never propose_change deleteFiles, whenever the goal is replacing a season.",
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'A series reference.' },
      season: { type: 'integer' },
      reason: {
        type: 'string',
        description: "Why, in the admin's terms: shown to them with it.",
      },
    },
    required: ['title', 'season', 'reason'],
  },
  async run(state, input) {
    const args = z
      .object({
        season: z.coerce.number().int().min(0),
        reason: z.string().trim().min(3).max(600),
      })
      .parse(input);
    const title = readTitleRef(input.title);
    if (!mayReplace(state.run)) {
      throw new ToolError(
        'Files are replaced only when an admin asks for it. Fill what is missing instead.'
      );
    }
    const proposed = await describeSeasonReplace(
      title,
      args.season,
      args.reason
    ).catch((e: unknown) => {
      throw e instanceof ChangeError
        ? new ToolError(
            `${e.message} Look further with search_releases and search_indexers; a release found there can replace the files with grab and replace: true.`
          )
        : e;
    });
    state.bind(title, await nameOf(title));
    state.propose(proposed);
    return `Proposed: ${proposed.headline}. The admin approves or declines it; stop here, and you hear what they decided next.`;
  },
};

export const searchUpgrade: AgentTool = {
  name: 'search_upgrade',
  askOnly: true,
  description:
    "Has Radarr, Sonarr or Lidarr search for a better release of a movie, of a series' episodes (all, a season, or some episodes) or of an album, and take one its quality profile prefers to what is there; the file is replaced only once the new one has imported. For when the admin asks for something better and the profile would prefer it. To take one particular release instead, grab it with replace: true.",
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'A title reference.' },
      season: { type: 'integer' },
      episodes: { type: 'array', items: { type: 'integer' } },
      reason: { type: 'string' },
    },
    required: ['title', 'reason'],
  },
  async run(state, input) {
    const args = z
      .object({
        season: z.coerce.number().int().min(0).optional(),
        episodes: z.array(z.coerce.number().int().min(0)).max(200).optional(),
        reason: z.string().trim().min(3).max(600),
      })
      .parse(input);
    const title = readTitleRef(input.title);
    const name = await nameOf(title);
    if (title.kind === 'album') {
      await backfill.lidarrFor(title.serverId).searchAlbums([title.arrId]);
      state.bind(title, name);
      return `Lidarr is searching for ${name}. It takes a release only if its profile prefers it to what is there; title_status shows what is downloading in a few minutes.`;
    }
    if (title.kind === 'movie') {
      await backfill.radarrFor(title.serverId).searchMovie(title.arrId);
      state.bind(title, name);
      return `Radarr is searching for ${name}. It takes a release only if its profile prefers it to the file there; title_status shows what is downloading in a few minutes.`;
    }
    if (args.episodes?.length && args.season === undefined) {
      throw new ToolError('Give the season the episodes are in.');
    }
    const sonarr = backfill.sonarrFor(title.serverId);
    const chosen = (await sonarr.getSeriesEpisodes(title.arrId)).filter(
      (ep) =>
        ep.monitored &&
        (args.season === undefined
          ? ep.seasonNumber > 0
          : ep.seasonNumber === args.season) &&
        (!args.episodes?.length || args.episodes.includes(ep.episodeNumber))
    );
    if (!chosen.length) {
      throw new ToolError('No monitored episodes there to search for.');
    }
    await sonarr.searchEpisodes(chosen.map((ep) => ep.id));
    state.bind(title, name);
    return `Sonarr is searching for ${chosen.length === 1 ? '1 episode' : `${chosen.length} episodes`} of ${name}. It takes a release only if its profile prefers it to the file there; title_status shows what is downloading in a few minutes.`;
  },
};

// ---- requesting ----------------------------------------------------------------

/**
 * An album not in Lidarr, requested for its artist (its first credited,
 * as the music pages do): once approved, Lidarr adds the artist and
 * searches for the album.
 */
const requestAlbum = async (
  state: AgentState,
  value: unknown
): Promise<string> => {
  const match = /^mb:album:([0-9a-f-]{36})$/i.exec(String(value ?? ''));
  if (!match) {
    throw new ToolError(
      'Use an album reference from find_title with music: true, like mb:album:4f6a2d93-c1e8-3a57-9b02-6d3e8f1c7a40.'
    );
  }
  if (!musicReady()) {
    throw new ToolError('Music is not set up, so albums cannot be requested.');
  }
  const albumMbid = match[1].toLowerCase();
  const album = await lookups.albumArtist(albumMbid).catch(() => {
    throw new ToolError(
      'MusicBrainz did not answer about that album; try again in a minute.'
    );
  });
  if (!album.artistMbid) {
    throw new ToolError(
      `MusicBrainz credits no artist for "${album.title}", so it cannot be requested.`
    );
  }
  const name = album.artist ? `${album.title} by ${album.artist}` : album.title;
  const request = await MediaRequest.requestMusic(
    { artistMbid: album.artistMbid, albums: [albumMbid] },
    state.user
  );
  state.act({
    at: new Date().toISOString(),
    type: 'request',
    title: name,
    detail: `Requested as ${state.user.displayName}`,
    requestId: request.id,
  });
  return `Requested ${name} (request #${request.id}). Once it is approved, Lidarr adds the artist and searches for the album; it can be checked with find_title in a few minutes. If Lidarr finds nothing, Backfill follows it.`;
};

export const requestTitle: AgentTool = {
  name: 'request_title',
  askOnly: true,
  description:
    'Requests a title that is not in the library yet, as the admin who asked, so Sonarr, Radarr or Lidarr adds and searches for it: a film or series by its TMDB reference, or an album by its MusicBrainz reference. Only when the admin asked for something that is not in the library.',
  parameters: {
    type: 'object',
    properties: {
      tmdb: {
        type: 'string',
        description: 'Like tmdb:tv:8627 from find_title.',
      },
      album: {
        type: 'string',
        description:
          'Like mb:album:4f6a2d93-c1e8-3a57-9b02-6d3e8f1c7a40 from find_title with music: true.',
      },
    },
  },
  async run(state, input) {
    if (input.album !== undefined) return requestAlbum(state, input.album);
    const match = /^tmdb:(tv|movie):(\d+)$/.exec(String(input.tmdb ?? ''));
    if (!match) {
      throw new ToolError(
        "Use a TMDB reference from find_title, like tmdb:tv:8627, or an album's, like mb:album:…."
      );
    }
    const mediaType = match[1] === 'tv' ? MediaType.TV : MediaType.MOVIE;
    const request = await MediaRequest.request(
      {
        mediaType,
        mediaId: Number(match[2]),
        ...(mediaType === MediaType.TV ? { seasons: 'all' as const } : {}),
      },
      state.user
    );
    state.act({
      at: new Date().toISOString(),
      type: 'request',
      title: `TMDB ${match[1]} ${match[2]}`,
      detail: `Requested as ${state.user.displayName}`,
      requestId: request.id,
    });
    return `Requested (request #${request.id}). ${
      mediaType === MediaType.TV ? 'Sonarr' : 'Radarr'
    } adds it and starts its own search in a minute or two; it can be checked with find_title after that.`;
  },
};
