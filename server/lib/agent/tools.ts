import { musicBrainz } from '@server/api/musicbrainz';
import type { ProwlarrRelease } from '@server/api/prowlarr';
import ProwlarrAPI, {
  AUDIO_CATEGORIES,
  MOVIE_CATEGORIES,
  TV_CATEGORIES,
} from '@server/api/prowlarr';
import type { LidarrAlbum } from '@server/api/servarr/lidarr';
import TheMovieDb from '@server/api/themoviedb';
import {
  MediaStatus,
  MediaType,
  VIDEO_MEDIA_TYPES,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import type { AgentAction, AgentRun } from '@server/entity/AgentRun';
import BackfillCandidate from '@server/entity/BackfillCandidate';
import BackfillJob from '@server/entity/BackfillJob';
import BackfillSeries from '@server/entity/BackfillSeries';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';
import type { ChangeInput, ProposedChange } from '@server/lib/agent/changes';
import {
  ChangeError,
  describeChange,
  describeSeasonReplace,
} from '@server/lib/agent/changes';
import {
  episodeByTitle,
  indexerReading,
  nameReading,
  sceneDiffers,
} from '@server/lib/agent/numbering';
import {
  MIN_VIDEO_BYTES,
  UNKNOWN_QUALITY,
  checkMapping,
  clip,
  deleteProblem,
  episodeLabel,
  fileNumbers,
  languageProblem,
  namesEpisode,
  numberedAs,
  rangeLabel,
  seasonLabel,
  sizeOf,
} from '@server/lib/agent/rules';
import type { ConverseTool } from '@server/lib/ai/providers';
import { judgeAlbumPack } from '@server/lib/backfill/albums';
import backfill from '@server/lib/backfill/engine';
import {
  IndexerLimitReached,
  PROWLARR,
  indexerLimits,
  limitHint,
} from '@server/lib/backfill/indexerLimit';
import type { PackFile } from '@server/lib/backfill/matcher';
import { mentionsShow } from '@server/lib/backfill/matcher';
import { movieName } from '@server/lib/backfill/movies';
import { baseName, canonicalName, isVideo } from '@server/lib/backfill/naming';
import type { PlanEntry } from '@server/lib/backfill/plan';
import { summarize } from '@server/lib/backfill/plan';
import type { RadarrMovieDetail } from '@server/lib/backfill/radarr';
import { relinkEpisodeFile } from '@server/lib/backfill/relink';
import type {
  ArrSearchRelease,
  SonarrEpisode,
  SonarrSeriesDetail,
} from '@server/lib/backfill/sonarr';
import { blockedGroupOf } from '@server/lib/blockedGroups';
import { musicReady } from '@server/lib/music/access';
import { isAudio } from '@server/lib/music/albumRelease';
import { albumStatuses } from '@server/lib/music/library';
import { rankAlbums } from '@server/lib/music/searchRank';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import type { MusicAlbumResult } from '@server/models/Music';
import { mapAlbumResult } from '@server/models/Music';
import { In, MoreThan } from 'typeorm';
import { z } from 'zod';

/*
 * What the admin agent can do: look titles up, read what they lack, search
 * the way Sonarr, Radarr and Lidarr do (with their reasons for turning
 * results down) and the way Prowlarr does, open a release to see its files,
 * and start a download of exactly the files it chose, mapped to the
 * episodes they are (an album's files are matched to its tracks by
 * Backfill). Downloads go through Backfill, which waits for disk space,
 * fetches only those files and has Sonarr, Radarr or Lidarr import each one
 * as what it was mapped to.
 *
 * Releases and titles are named by short references ("r3",
 * "series:1:1283"); links, keys and paths on the server never reach the
 * model.
 */

/** A release found during a run, named by its reference. */
export interface KnownRelease extends ProwlarrRelease {
  ref: string;
  source: 'sonarr' | 'radarr' | 'lidarr' | 'prowlarr';
  /**
   * A Usenet post in archives, or with scrambled file names, found when it
   * was opened: its files can't be listed before it is downloaded.
   */
  packed?: 'archives' | 'scrambled';
}

export interface TitleRef {
  kind: 'series' | 'movie' | 'album';
  serverId: number;
  arrId: number;
}

/** What one run knows as it goes. */
export interface AgentState {
  run: AgentRun;
  /** Who it acts as: the admin who asked, or the owner. */
  user: User;
  releases: Map<string, KnownRelease>;
  files: Map<string, PackFile[]>;
  series: Map<number, SonarrSeriesDetail[]>;
  movies: Map<number, RadarrMovieDetail[]>;
  /** Each Lidarr's albums, with its artists' names, read once a run. */
  albums?: Map<number, LibraryAlbums>;
  /** Downloads started in the last day, this run's included. */
  grabsToday: number;
  /** Ties the run to the first library title it works on. */
  bind(title: TitleRef, name: string): void;
  act(action: AgentAction): void;
  /** Pauses the run with a question for an admin. */
  ask(question: string): void;
  /**
   * Puts a change to an admin, to approve or decline: the run pauses once
   * this turn's tools are done, with every change proposed in it.
   */
  propose(change: ProposedChange): void;
}

/** A Lidarr's albums, and the names of their artists by id. */
interface LibraryAlbums {
  albums: LidarrAlbum[];
  artists: Map<number, string>;
}

/** A refusal the model is told about, to try something else. */
export class ToolError extends Error {}

/**
 * A release turned down for what it is (a dub in another language), not
 * for how it was asked for: remembered for the title, so later
 * conversations don't try it again.
 */
export class Refused extends ToolError {}

export interface AgentTool extends ConverseTool {
  /** Only when an admin asked, never on its own. */
  askOnly?: boolean;
  /** Only looks; several in one turn run at the same time. */
  readOnly?: boolean;
  run(state: AgentState, input: Record<string, unknown>): Promise<string>;
}

// ---- titles ----------------------------------------------------------------

/**
 * Whether an admin is in the conversation: they asked, or have replied
 * since. Only then may it propose changes or request titles.
 */
export const adminPresent = (run: AgentRun): boolean =>
  run.trigger === 'ask' || run.steps.some((step) => step.kind === 'reply');

/** Someone reported the files bad and asked for them to be replaced. */
const replaceReported = (run: AgentRun): boolean =>
  !!(run.memory as { report?: { replace?: boolean } } | null)?.report?.replace;

/**
 * Whether replacing files may be proposed: with an admin in the
 * conversation, or for a report asking for it. Either way it only waits
 * for an admin's approval; nothing is replaced before that.
 */
export const mayReplace = (run: AgentRun): boolean =>
  adminPresent(run) || replaceReported(run);

export const titleRef = (title: TitleRef) =>
  `${title.kind}:${title.serverId}:${title.arrId}`;

export const readTitleRef = (value: unknown): TitleRef => {
  const match = /^(series|movie|album):(\d+):(\d+)$/.exec(String(value ?? ''));
  if (!match) {
    throw new ToolError(
      'That is not a title reference. Use one find_title gave, like series:1:1283.'
    );
  }
  return {
    kind: match[1] as TitleRef['kind'],
    serverId: Number(match[2]),
    arrId: Number(match[3]),
  };
};

/** The main servers: a 4K twin of one is the same library. */
const mainServers = <T extends SonarrSettings | RadarrSettings>(
  servers: T[]
): T[] => {
  const main = servers.filter((s) => !s.is4k);
  return main.length ? main : servers;
};

const normalize = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Every word of the query is in the title, in any order. */
export const titleMatches = (query: string, ...titles: string[]) => {
  const words = normalize(query).split(' ').filter(Boolean);
  if (!words.length) return false;
  return titles.some((title) => {
    const have = ` ${normalize(title)} `;
    return words.every((word) => have.includes(` ${word} `));
  });
};

const librarySeries = async (state: AgentState, serverId: number) => {
  let list = state.series.get(serverId);
  if (!list) {
    list = await backfill.sonarrFor(serverId).getAllSeries();
    state.series.set(serverId, list);
  }
  return list;
};

const libraryMovies = async (state: AgentState, serverId: number) => {
  let list = state.movies.get(serverId);
  if (!list) {
    list = await backfill.radarrFor(serverId).getAllMovies();
    state.movies.set(serverId, list);
  }
  return list;
};

const libraryAlbums = async (
  state: AgentState,
  serverId: number
): Promise<LibraryAlbums> => {
  state.albums ??= new Map();
  let library = state.albums.get(serverId);
  if (!library) {
    const lidarr = backfill.lidarrFor(serverId);
    const [albums, artists] = await Promise.all([
      lidarr.getAlbums(),
      lidarr.getArtists(),
    ]);
    library = {
      albums,
      artists: new Map(artists.map((a) => [a.id, a.artistName])),
    };
    state.albums.set(serverId, library);
  }
  return library;
};

/** "Album by Artist", as Lidarr has it. */
const albumName = async (title: TitleRef): Promise<string> => {
  const lidarr = backfill.lidarrFor(title.serverId);
  const album = await lidarr.getAlbumDetail(title.arrId);
  const artist = await lidarr
    .getArtistDetail(album.artistId)
    .catch(() => undefined);
  return artist ? `${album.title} by ${artist.artistName}` : album.title;
};

/** Albums are for Backfill only while it does music. */
const musicOn = () => backfill.readiness().music;

/** Outside lookups, as a seam for tests. */
export const lookups = {
  tmdb: (query: string) => new TheMovieDb().searchMulti({ query }),
  /** Albums on MusicBrainz, as music search ranks them, with Seerr's status. */
  albums: async (query: string): Promise<MusicAlbumResult[]> => {
    const page = await musicBrainz().searchReleaseGroups(query, { limit: 10 });
    const groups = rankAlbums(page['release-groups'] ?? [], 6);
    const statuses = await albumStatuses(groups.map((g) => g.id));
    return groups.map((group) => mapAlbumResult(group, statuses));
  },
  /** An album's own artist, its first credited, on MusicBrainz. */
  albumArtist: async (
    albumMbid: string
  ): Promise<{ title: string; artistMbid?: string; artist?: string }> => {
    const group = await musicBrainz().getReleaseGroup(albumMbid);
    const credit = group['artist-credit']?.[0]?.artist;
    return { title: group.title, artistMbid: credit?.id, artist: credit?.name };
  },
};

const SEERR_STATUS: Record<number, string> = {
  [MediaStatus.UNKNOWN]: 'not requested',
  [MediaStatus.PENDING]: 'requested, waiting for approval',
  [MediaStatus.PROCESSING]: 'requested',
  [MediaStatus.PARTIALLY_AVAILABLE]: 'partly available',
  [MediaStatus.AVAILABLE]: 'available',
  [MediaStatus.BLOCKLISTED]: 'blocklisted',
  [MediaStatus.DELETED]: 'deleted',
};

const findTitle: AgentTool = {
  name: 'find_title',
  readOnly: true,
  description:
    'Finds a series or movie by name in the Sonarr and Radarr libraries, or an album by its name or its artist in Lidarr (giving a title reference to use with the other tools), and on TMDB for films and series not in the library yet. With music: true it also looks the name up on MusicBrainz, for an album not in Lidarr ("Album Artist" finds it best).',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The title, or part of it.' },
      music: {
        type: 'boolean',
        description: 'Also look for albums on MusicBrainz.',
      },
    },
    required: ['query'],
  },
  async run(state, input) {
    const { query, music } = z
      .object({
        query: z.string().trim().min(1).max(200),
        music: z.boolean().optional(),
      })
      .parse(input);
    const settings = getSettings();
    const lines: string[] = [];
    for (const server of mainServers(settings.sonarr)) {
      const matches = (await librarySeries(state, server.id))
        .filter((s) =>
          titleMatches(
            query,
            s.title,
            ...(s.alternateTitles ?? []).map((alt) => alt.title)
          )
        )
        .slice(0, 8);
      for (const s of matches) {
        const stats = s.statistics;
        lines.push(
          `${titleRef({ kind: 'series', serverId: server.id, arrId: s.id })}  ${s.title}${
            s.year ? ` (${s.year})` : ''
          } — series in Sonarr${
            stats
              ? `, ${stats.episodeFileCount} of ${stats.episodeCount} episodes on disk`
              : ''
          }`
        );
      }
    }
    for (const server of mainServers(settings.radarr)) {
      const matches = (await libraryMovies(state, server.id))
        .filter((m) =>
          titleMatches(
            query,
            m.title,
            m.originalTitle ?? '',
            ...(m.alternateTitles ?? []).map((alt) => alt.title)
          )
        )
        .slice(0, 8);
      for (const m of matches) {
        lines.push(
          `${titleRef({ kind: 'movie', serverId: server.id, arrId: m.id })}  ${m.title} (${m.year}) — movie in Radarr, ${
            m.hasFile ? 'on disk' : 'not on disk'
          }`
        );
      }
    }

    if (musicOn()) {
      for (const server of settings.lidarr) {
        const library = await libraryAlbums(state, server.id).catch(
          () => undefined
        );
        if (!library) continue;
        const matches = library.albums
          .filter((album) => {
            const artist = library.artists.get(album.artistId) ?? '';
            return titleMatches(query, album.title, `${artist} ${album.title}`);
          })
          .slice(0, 8);
        for (const album of matches) {
          const stats = album.statistics;
          const year = album.releaseDate?.slice(0, 4);
          lines.push(
            `${titleRef({ kind: 'album', serverId: server.id, arrId: album.id })}  ${album.title} by ${
              library.artists.get(album.artistId) ?? 'an unknown artist'
            }${year && year !== '0001' ? ` (${year})` : ''} — album in Lidarr${
              stats
                ? `, ${stats.trackFileCount} of ${stats.trackCount} tracks on disk`
                : ''
            }${album.monitored ? '' : ', not monitored'}`
          );
        }
      }
    }

    const tmdb = await lookups.tmdb(query).catch(() => null);
    const found = (tmdb?.results ?? [])
      .filter(
        (r): r is typeof r & { media_type: 'tv' | 'movie' } =>
          r.media_type === 'tv' || r.media_type === 'movie'
      )
      .slice(0, 6);
    if (found.length) {
      const media = await getRepository(Media).find({
        where: {
          tmdbId: In(found.map((r) => r.id)),
          mediaType: In(VIDEO_MEDIA_TYPES),
        },
      });
      for (const r of found) {
        const type = r.media_type === 'tv' ? MediaType.TV : MediaType.MOVIE;
        const known = media.find(
          (m) => m.tmdbId === r.id && m.mediaType === type
        );
        const name =
          'name' in r && r.name ? r.name : 'title' in r ? r.title : '';
        const date =
          'first_air_date' in r && r.first_air_date
            ? r.first_air_date
            : 'release_date' in r
              ? r.release_date
              : '';
        lines.push(
          `tmdb:${r.media_type}:${r.id}  ${name}${date ? ` (${date.slice(0, 4)})` : ''} — on TMDB, in Seerr: ${
            SEERR_STATUS[known?.status ?? MediaStatus.UNKNOWN] ?? 'unknown'
          }`
        );
      }
    }
    if (music && musicReady()) {
      const albums = await lookups.albums(query).catch(() => null);
      if (!albums) {
        lines.push('MusicBrainz did not answer; try again in a minute.');
      }
      for (const album of albums ?? []) {
        lines.push(
          `mb:album:${album.id}  ${album.title}${
            album.artistName ? ` by ${album.artistName}` : ''
          }${album.releaseDate ? ` (${album.releaseDate.slice(0, 4)})` : ''}${
            album.primaryType ? `, ${album.primaryType}` : ''
          }${
            album.secondaryTypes.length
              ? ` (${album.secondaryTypes.join(', ')})`
              : ''
          } — on MusicBrainz, in Seerr: ${
            SEERR_STATUS[album.status ?? MediaStatus.UNKNOWN] ?? 'unknown'
          }`
        );
      }
    }
    return lines.length
      ? lines.join('\n')
      : `Nothing called "${query}" in the libraries or on TMDB.${
          musicReady() && !music
            ? ' For an album not in Lidarr, look again with music: true.'
            : ''
        }`;
  },
};

// ---- what a title has and lacks ---------------------------------------------

const MAX_LISTED_MISSING = 150;

/** Backfill's row for a title, and its downloads under way. */
const backfillOf = async (title: TitleRef) => {
  const row = await getRepository(BackfillSeries).findOne({
    where: { kind: title.kind, serverId: title.serverId, arrId: title.arrId },
  });
  const jobs = row
    ? await getRepository(BackfillJob).find({
        where: {
          seriesId: row.id,
          status: In(['queued', 'downloading', 'importing', 'paused']),
        },
        order: { id: 'ASC' },
      })
    : [];
  return { row, jobs };
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Downloads of a title that failed in the last day, newest first. */
const failedLately = (seriesId: number) =>
  getRepository(BackfillJob).find({
    where: {
      seriesId,
      status: 'failed',
      finishedAt: MoreThan(new Date(Date.now() - DAY_MS)),
    },
    order: { id: 'DESC' },
    take: 5,
  });

const backfillLine = async (title: TitleRef) => {
  const { row, jobs } = await backfillOf(title);
  if (!row) return 'Backfill: not following it yet.';
  const failed = await failedLately(row.id);
  return `Backfill: ${row.status}${
    row.lastSearchedAt
      ? `, last searched ${new Date(row.lastSearchedAt).toISOString().slice(0, 10)}`
      : ''
  }${
    jobs.length
      ? jobs
          .map(
            (job) =>
              `; job #${job.id} is ${job.status} (${job.progress}%) for "${job.title}"`
          )
          .join('')
      : '; no download running'
  }${failed
    .map(
      (job) =>
        `; job #${job.id} failed for "${job.title}" (${(
          job.error ?? 'it failed'
        ).replace(/\.$/, '')}${
          job.replacedById ? `; replaced by #${job.replacedById}` : ''
        }): never take that release again`
    )
    .join('')}.`;
};

/**
 * Which releases failed to download for a title before: the same release
 * by its link, its torrent's hash or its name (a post found again on
 * another indexer).
 */
const failedReleases = async (
  title: TitleRef | null
): Promise<(release: ProwlarrRelease) => boolean> => {
  if (!title) return () => false;
  const row = await getRepository(BackfillSeries).findOne({
    where: { kind: title.kind, serverId: title.serverId, arrId: title.arrId },
  });
  if (!row) return () => false;
  const dead = await getRepository(BackfillCandidate).find({
    select: { guid: true, infoHash: true, title: true },
    where: { seriesId: row.id, status: 'dead' },
  });
  return (release) => dead.some((c) => sameRelease(c, release));
};

/** Whether a pack found before is this release. */
const sameRelease = (
  pack: Pick<BackfillCandidate, 'guid' | 'infoHash' | 'title'>,
  release: ProwlarrRelease
) =>
  pack.guid === release.guid ||
  (!!release.infoHash && pack.infoHash === release.infoHash.toLowerCase()) ||
  pack.title.toLowerCase() === release.title.toLowerCase();

/** The title a run is bound to, once it is. */
export const boundTitle = (run: AgentRun): TitleRef | null =>
  run.kind && run.arrId !== null && run.arrId !== undefined
    ? { kind: run.kind, serverId: run.serverId ?? 0, arrId: run.arrId }
    : null;

const titleStatus: AgentTool = {
  name: 'title_status',
  readOnly: true,
  description:
    "What a library title has and lacks: episodes on disk per season, every missing episode with its title and air date (or an album's tracks, on disk or missing), what is already downloading, and what Backfill is doing.",
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'A title reference from find_title.',
      },
    },
    required: ['title'],
  },
  async run(state, input) {
    const title = readTitleRef(input.title);
    if (title.kind === 'album') {
      const lidarr = backfill.lidarrFor(title.serverId);
      const album = await lidarr.getAlbumDetail(title.arrId);
      const artist = await lidarr.getArtistDetail(album.artistId);
      const name = `${album.title} by ${artist.artistName}`;
      state.bind(title, name);
      const [tracks, files, queued, profile] = await Promise.all([
        lidarr.getAlbumTracks(album.id),
        lidarr.getAlbumTrackFiles(album.id),
        lidarr.getAlbumQueueCount(album.id).catch(() => 0),
        lidarr.getQualityProfile(artist.qualityProfileId).catch(() => null),
      ]);
      const quality = new Map(
        files.map((f) => [f.id, f.quality?.quality.name ?? 'Unknown'])
      );
      const backfilling = new Map<number, number>();
      for (const job of (await backfillOf(title)).jobs) {
        for (const file of job.files) {
          for (const id of file.episodeIds) backfilling.set(id, job.id);
        }
      }
      const edition = album.releases?.find((r) => r.monitored);
      const missing = tracks.filter((t) => !t.hasFile);
      const year = album.releaseDate?.slice(0, 4);
      return [
        `${name}${year && year !== '0001' ? ` (${year})` : ''} — ${titleRef(title)}, Lidarr${
          album.albumType ? `, ${album.albumType}` : ''
        }; ${album.monitored ? 'monitored' : 'not monitored'}${
          profile ? `; quality profile ${profile.name}` : ''
        }.`,
        edition
          ? `Edition Lidarr imports into: ${edition.title}${
              edition.format ? `, ${edition.format}` : ''
            }, ${edition.trackCount ?? tracks.length} tracks${
              (album.releases?.length ?? 0) > 1
                ? ` (one of ${album.releases!.length} editions)`
                : ''
            }.`
          : '',
        `${tracks.length - missing.length} of ${tracks.length} tracks on disk.`,
        ...tracks
          .slice()
          .sort(
            (a, b) =>
              (a.mediumNumber ?? 1) - (b.mediumNumber ?? 1) ||
              (a.absoluteTrackNumber ?? 0) - (b.absoluteTrackNumber ?? 0)
          )
          .slice(0, MAX_LISTED_MISSING)
          .map(
            (t) =>
              `${t.absoluteTrackNumber ?? t.trackNumber ?? '?'}. "${t.title}" ${
                t.hasFile
                  ? `on disk (${quality.get(t.trackFileId ?? 0) ?? 'Unknown'})`
                  : backfilling.has(t.id)
                    ? `missing [downloading in Backfill job #${backfilling.get(t.id)}]`
                    : 'missing'
              }`
          ),
        queued ? `Downloading in Lidarr: ${queued} item(s).` : '',
        await backfillLine(title),
      ]
        .filter(Boolean)
        .join('\n');
    }
    if (title.kind === 'movie') {
      const radarr = backfill.radarrFor(title.serverId);
      const movie = await radarr.getMovieDetail(title.arrId);
      state.bind(title, movie.title);
      const [file, queued] = await Promise.all([
        movie.hasFile ? radarr.getMovieFile(movie.id) : null,
        radarr.getMovieQueueCount(movie.id),
      ]);
      return [
        `${movie.title} (${movie.year}) — ${titleRef(title)}, Radarr. Original language: ${
          movie.originalLanguage?.name ?? 'unknown'
        }.`,
        movie.hasFile
          ? `On disk: ${file?.quality?.quality.name ?? 'yes'}${
              file?.mediaInfo?.audioLanguages
                ? `, audio ${file.mediaInfo.audioLanguages}`
                : ''
            }.`
          : `Not on disk; ${movie.isAvailable ? 'released' : 'not released yet'}; ${
              movie.monitored ? 'monitored' : 'not monitored'
            }.`,
        queued ? `Downloading in Radarr: ${queued} item(s).` : '',
        await backfillLine(title),
      ]
        .filter(Boolean)
        .join('\n');
    }

    const sonarr = backfill.sonarrFor(title.serverId);
    const series = await sonarr.getSeriesDetail(title.arrId);
    state.bind(title, series.title);
    const [episodes, files, queued] = await Promise.all([
      sonarr.getSeriesEpisodes(series.id),
      sonarr.getEpisodeFiles(series.id),
      sonarr.getSeriesQueueEpisodes(series.id).catch(() => [] as number[]),
    ]);
    const now = Date.now();
    // What the files on disk are, and the audio Sonarr heard in them.
    const qualities = new Map<number, Map<string, number>>();
    const audio = new Map<number, Map<string, number>>();
    const count = (
      into: Map<number, Map<string, number>>,
      season: number,
      key: string
    ) => {
      const bySeason = into.get(season) ?? new Map<string, number>();
      bySeason.set(key, (bySeason.get(key) ?? 0) + 1);
      into.set(season, bySeason);
    };
    for (const file of files) {
      count(
        qualities,
        file.seasonNumber,
        file.quality?.quality.name ?? 'Unknown'
      );
      count(
        audio,
        file.seasonNumber,
        file.mediaInfo?.audioLanguages || 'audio not read yet'
      );
    }
    const seasons = [...new Set(episodes.map((ep) => ep.seasonNumber))].sort(
      (a, b) => a - b
    );
    const seasonLines = seasons.map((season) => {
      const all = episodes.filter((ep) => ep.seasonNumber === season);
      const have = all.filter((ep) => ep.hasFile).length;
      const list = (from: Map<number, Map<string, number>>) =>
        [...(from.get(season) ?? new Map<string, number>()).entries()]
          .map(([name, n]) => `${name} ×${n}`)
          .join(', ');
      const kinds = list(qualities);
      const heard = list(audio);
      return `${season === 0 ? 'Specials' : `Season ${season}`}: ${have} of ${all.length} on disk${
        kinds ? ` (${kinds}; audio: ${heard})` : ''
      }${all.some((ep) => ep.monitored) ? '' : ', not monitored'}`;
    });
    const missing = episodes
      .filter(
        (ep) =>
          !ep.hasFile &&
          ep.monitored &&
          (!ep.airDateUtc || new Date(ep.airDateUtc).getTime() <= now)
      )
      .sort(
        (a, b) =>
          a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber
      );
    const upcoming = episodes.filter(
      (ep) =>
        !ep.hasFile && ep.airDateUtc && new Date(ep.airDateUtc).getTime() > now
    ).length;
    // A file about twice an episode's length, linked to one episode, most
    // likely holds two: relink_file links it to all it holds.
    const minutes = (runTime?: string) => {
      const parts = (runTime ?? '').split(':').map(Number);
      if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) return 0;
      return parts.length === 3
        ? parts[0] * 60 + parts[1] + parts[2] / 60
        : parts[0] + parts[1] / 60;
    };
    const doubled = series.runtime
      ? files
          .filter(
            (f) =>
              minutes(f.mediaInfo?.runTime) >= series.runtime! * 1.7 &&
              episodes.filter((ep) => ep.episodeFileId === f.id).length === 1
          )
          .map((f) => {
            const ep = episodes.find((e) => e.episodeFileId === f.id)!;
            return `${episodeLabel(ep.seasonNumber, ep.episodeNumber)} (${f.mediaInfo?.runTime})`;
          })
      : [];
    const queuedIds = new Set(queued);
    const backfilling = new Map<number, number>();
    for (const job of (await backfillOf(title)).jobs) {
      for (const file of job.files) {
        for (const id of file.episodeIds) backfilling.set(id, job.id);
      }
    }
    const missingLines = missing
      .slice(0, MAX_LISTED_MISSING)
      .map(
        (ep) =>
          `${episodeLabel(ep.seasonNumber, ep.episodeNumber)}${
            ep.absoluteEpisodeNumber ? ` #${ep.absoluteEpisodeNumber}` : ''
          } "${ep.title ?? ''}" ${ep.airDateUtc?.slice(0, 10) ?? ''}${
            sceneDiffers(ep)
              ? ` (scene ${episodeLabel(ep.sceneSeasonNumber!, ep.sceneEpisodeNumber!)})`
              : ''
          }${
            queuedIds.has(ep.id)
              ? ' [downloading in Sonarr]'
              : backfilling.has(ep.id)
                ? ` [downloading in Backfill job #${backfilling.get(ep.id)}]`
                : ''
          }`
      );
    return [
      `${series.title}${series.year ? ` (${series.year})` : ''} — ${titleRef(title)}, Sonarr, ${
        series.seriesType
      }. Original language: ${originalOf(series) ?? 'unknown'}${
        series.seriesType === 'anime'
          ? ' (anime: English audio may not exist; the original with subtitles is fine)'
          : ''
      }.`,
      ...seasonLines,
      episodes.some(sceneDiffers)
        ? "Sonarr numbers this series by the scene's seasons (TheXEM): it searches for an episode by its scene number, shown in brackets, and reads every release name that way, so a release named by the library's numbers can be read as another episode. Search by each episode's title too, and go by titles."
        : '',
      `Missing, monitored and aired (${missing.length}):`,
      ...missingLines,
      missing.length > MAX_LISTED_MISSING
        ? `… and ${missing.length - MAX_LISTED_MISSING} more.`
        : '',
      upcoming ? `Not aired yet: ${upcoming}.` : '',
      doubled.length
        ? `Files about twice an episode's ${series.runtime} minutes but linked to one episode, likely holding two: ${doubled
            .slice(0, 20)
            .join(
              ', '
            )}${doubled.length > 20 ? ` and ${doubled.length - 20} more` : ''}.`
        : '',
      await backfillLine(title),
    ]
      .filter(Boolean)
      .join('\n');
  },
};

// ---- searching ---------------------------------------------------------------

const MAX_LISTED_RELEASES = 30;

const remember = (
  state: AgentState,
  release: ProwlarrRelease,
  source: KnownRelease['source']
): KnownRelease => {
  const same = [...state.releases.values()].find(
    (known) => known.guid === release.guid
  );
  if (same) return same;
  const known: KnownRelease = {
    ...release,
    ref: `r${state.releases.size + 1}`,
    source,
  };
  state.releases.set(known.ref, known);
  return known;
};

const reasonsOf = (release: ArrSearchRelease) =>
  (release.rejections ?? [])
    .map((r) => (typeof r === 'string' ? r : (r.reason ?? '')))
    .filter(Boolean);

const asRelease = (release: ArrSearchRelease): ProwlarrRelease | null => {
  const protocol =
    release.protocol === 'torrent' || release.protocol === 'usenet'
      ? release.protocol
      : null;
  if (!protocol) return null;
  return {
    guid: release.guid,
    title: release.title,
    size: release.size ?? 0,
    indexerId: release.indexerId,
    indexer: (release.indexer ?? '').replace(/ \(Prowlarr\)$/, ''),
    protocol,
    seeders: release.seeders,
    downloadUrl: release.downloadUrl,
    magnetUrl: release.magnetUrl,
    infoHash: release.infoHash,
    publishDate: release.publishDate,
  };
};

const releaseLine = (
  known: KnownRelease,
  extra: {
    what?: string;
    quality?: string;
    approved?: boolean;
    why?: string[];
    /** It failed to download for this title before. */
    failed?: boolean;
    /** Which library episode it is, by its name. */
    reading?: string;
  }
) => {
  const blocked = blockedGroupOf(known.title);
  return [
    known.ref,
    extra.what,
    extra.reading,
    sizeOf(known.size),
    known.protocol === 'torrent' ? `${known.seeders ?? 0} seeders` : 'usenet',
    extra.quality,
    known.indexer,
    `"${known.title}"`,
    blocked
      ? `blocked group ${blocked}: never take it`
      : extra.failed
        ? 'failed to download for this title: never take it again'
        : extra.approved
          ? 'accepted'
          : extra.why?.length
            ? `turned down: ${extra.why.slice(0, 3).join('; ').slice(0, 300)}`
            : '',
  ]
    .filter(Boolean)
    .join(' | ');
};

/** How long search_releases waits on Sonarr or Radarr, and keeps results. */
export const searchTiming = {
  waitMs: 90_000,
  keepMs: 20 * 60_000,
};

interface ArrSearch {
  startedAt: number;
  doneAt?: number;
  results?: ArrSearchRelease[];
  error?: unknown;
  settled: Promise<void>;
}

/**
 * Sonarr's and Radarr's own searches, by what was searched. A search is
 * left to finish when the tool stops waiting on it (Sonarr goes on with it
 * anyway, and an anime season can take minutes, episode by episode), so
 * asking again picks up its results rather than starting another.
 */
const arrSearches = new Map<string, ArrSearch>();

export const forgetSearches = () => arrSearches.clear();

const arrSearch = async (
  key: string,
  start: () => Promise<ArrSearchRelease[]>
): Promise<
  | { results: ArrSearchRelease[]; ageMs: number }
  | { pending: true; forMs: number }
> => {
  const now = Date.now();
  for (const [k, search] of arrSearches) {
    if (search.doneAt && now - search.doneAt > searchTiming.keepMs) {
      arrSearches.delete(k);
    }
  }
  let search = arrSearches.get(key);
  if (!search) {
    const fresh: ArrSearch = {
      startedAt: now,
      settled: Promise.resolve(),
    };
    fresh.settled = start().then(
      (results) => {
        fresh.results = results;
        fresh.doneAt = Date.now();
      },
      (error) => {
        fresh.error = error;
        fresh.doneAt = Date.now();
      }
    );
    arrSearches.set(key, fresh);
    search = fresh;
  }
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    search.settled,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, searchTiming.waitMs);
    }),
  ]);
  clearTimeout(timer);
  if (!search.doneAt) {
    return { pending: true, forMs: Date.now() - search.startedAt };
  }
  if (search.error !== undefined) {
    // A failed search is tried afresh next time.
    arrSearches.delete(key);
    throw search.error;
  }
  return { results: search.results ?? [], ageMs: Date.now() - search.doneAt };
};

/**
 * A series' episodes and the names releases call it by, to say which
 * library episode a release is. Empty when the series cannot be read.
 */
const libraryOf = async (
  title: TitleRef
): Promise<{ episodes: SonarrEpisode[]; names: string[] }> => {
  try {
    const sonarr = backfill.sonarrFor(title.serverId);
    const [series, episodes] = await Promise.all([
      sonarr.getSeriesDetail(title.arrId),
      sonarr.getSeriesEpisodes(title.arrId),
    ]);
    const names = [
      series.title,
      series.title.replace(/\s*\(\d{4}\)$/, ''),
      ...(series.originalTitle ? [series.originalTitle] : []),
      ...(series.alternateTitles ?? []).map((alt) => alt.title),
    ].filter(Boolean);
    return { episodes, names };
  } catch {
    return { episodes: [], names: [] };
  }
};

/** What a release is by its name, when it is one of this series' at all. */
const readingOf = (
  name: string,
  library: { episodes: SonarrEpisode[]; names: string[] }
): string | undefined =>
  library.episodes.length && mentionsShow(name, library.names)
    ? indexerReading(name, library.episodes) || undefined
    : undefined;

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

const searchReleases: AgentTool = {
  name: 'search_releases',
  readOnly: true,
  description:
    "Runs Sonarr's, Radarr's or Lidarr's own search across their indexers, like an interactive search: every result with what it maps to, its quality and size, and the reasons it was turned down. For a series, give a season (or a season and episode). Slow: a season of an anime can take several minutes, since Sonarr searches it episode by episode. If it is not done within a minute and a half you are told so; it keeps going, and calling it again with the same title and season gives its results. Search Prowlarr with search_indexers meanwhile.",
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'A title reference.' },
      season: { type: 'integer', description: 'Series only.' },
      episode: {
        type: 'integer',
        description: 'Series only, with season: one episode.',
      },
    },
    required: ['title'],
  },
  async run(state, input) {
    const title = readTitleRef(input.title);
    const { season, episode } = z
      .object({
        season: z.coerce.number().int().min(0).optional(),
        episode: z.coerce.number().int().min(0).optional(),
      })
      .parse(input);
    let key: string;
    let start: () => Promise<ArrSearchRelease[]>;
    let what: string;
    /** Said when an episode searched by its scene number finds nothing. */
    let sceneHint = '';
    if (title.kind === 'album') {
      const lidarr = backfill.lidarrFor(title.serverId);
      key = titleRef(title);
      start = () => lidarr.getReleases(title.arrId);
      what = 'Lidarr is still searching';
    } else if (title.kind === 'movie') {
      const radarr = backfill.radarrFor(title.serverId);
      key = titleRef(title);
      start = () => radarr.getReleases(title.arrId);
      what = 'Radarr is still searching';
    } else {
      if (season === undefined) {
        throw new ToolError('Give a season to search.');
      }
      const sonarr = backfill.sonarrFor(title.serverId);
      if (episode !== undefined) {
        const target = (await sonarr.getSeriesEpisodes(title.arrId)).find(
          (ep) => ep.seasonNumber === season && ep.episodeNumber === episode
        );
        if (!target) {
          throw new ToolError(
            `${episodeLabel(season, episode)} is not an episode of this series.`
          );
        }
        key = `${titleRef(title)}:${season}:${episode}`;
        start = () => sonarr.getReleases({ episodeId: target.id });
        if (sceneDiffers(target)) {
          sceneHint = ` Sonarr searched for it by its scene number, ${episodeLabel(
            target.sceneSeasonNumber!,
            target.sceneEpisodeNumber!
          )}: use search_indexers with ${episodeLabel(season, episode)} and with its title, "${target.title ?? ''}".`;
        }
        what = `Sonarr is still searching for ${episodeLabel(season, episode)}`;
      } else {
        key = `${titleRef(title)}:${season}`;
        start = () =>
          sonarr.getReleases({ seriesId: title.arrId, seasonNumber: season });
        what = `Sonarr is still searching season ${season}`;
      }
    }
    const found = await arrSearch(key, start);
    if ('pending' in found) {
      return `${what} (${minutes(found.forMs)} min so far). It keeps going: call search_releases again with the same title${
        title.kind === 'series' ? ' and season' : ''
      } for its results, and use search_indexers meanwhile.`;
    }
    // A season's search brings back other seasons too (a long-running show
    // fills the list with its newest): only this season's, packs that cover
    // it, and releases Sonarr could not place, which may be collections.
    const placedElsewhere = (r: ArrSearchRelease) => {
      if (
        title.kind !== 'series' ||
        episode !== undefined ||
        season === undefined
      ) {
        return false;
      }
      // Sonarr v5 lists every season a pack covers; the season it maps a
      // pack to is only the first of them.
      if (r.seasonNumbers && r.seasonNumbers.length > 1) {
        return !r.seasonNumbers.includes(season);
      }
      if (r.mappedSeasonNumber !== undefined && r.mappedSeasonNumber !== null) {
        return r.mappedSeasonNumber !== season;
      }
      return r.seasonNumber !== undefined && r.seasonNumber !== season;
    };
    const results = found.results.filter((r) => !placedElsewhere(r));
    const elsewhere = found.results.length - results.length;
    const others = elsewhere
      ? ` (${elsewhere} more for other seasons left out)`
      : '';
    const earlier =
      found.ageMs > 60_000
        ? ` (from a search ${minutes(found.ageMs)} min ago)`
        : '';
    if (!results.length) {
      return `No results from any indexer${earlier}${others}.${sceneHint}`;
    }
    const failed = await failedReleases(title);
    // The library's episodes, to say which each release is by its title as
    // well as by Sonarr's mapping.
    const library =
      title.kind === 'series'
        ? await libraryOf(title)
        : { episodes: [] as SonarrEpisode[], names: [] as string[] };
    // Accepted first, then what is for a missing episode (by Sonarr's
    // mapping or the name's title), then anything Sonarr placed, then what
    // it could not: otherwise a search Sonarr accepted nothing from shows
    // its first 30 rows of other shows.
    const missingIds = new Set(
      library.episodes.filter((ep) => !ep.hasFile).map((ep) => ep.id)
    );
    const rankOf = (r: ArrSearchRelease) => {
      if (r.approved) return 3;
      const mappedIds = library.episodes
        .filter(
          (ep) =>
            ep.seasonNumber === (r.mappedSeasonNumber ?? season) &&
            (r.mappedEpisodeNumbers ?? []).includes(ep.episodeNumber)
        )
        .map((ep) => ep.id);
      const titled =
        library.episodes.length && mentionsShow(r.title, library.names)
          ? episodeByTitle(r.title, library.episodes)
          : undefined;
      if (
        mappedIds.some((id) => missingIds.has(id)) ||
        (titled && missingIds.has(titled.id)) ||
        (r.fullSeason && title.kind === 'series')
      ) {
        return 2;
      }
      return r.mappedEpisodeNumbers?.length || r.fullSeason ? 1 : 0;
    };
    const sorted = [...results]
      .map((r) => ({ r, rank: rankOf(r) }))
      .sort(
        (a, b) => b.rank - a.rank || (b.r.seeders ?? 0) - (a.r.seeders ?? 0)
      )
      .map(({ r }) => r);
    const lines: string[] = [];
    for (const result of sorted.slice(0, MAX_LISTED_RELEASES)) {
      const release = asRelease(result);
      if (!release) continue;
      const known = remember(
        state,
        release,
        title.kind === 'movie'
          ? 'radarr'
          : title.kind === 'album'
            ? 'lidarr'
            : 'sonarr'
      );
      const what =
        title.kind !== 'series'
          ? undefined
          : result.seasonNumbers && result.seasonNumbers.length > 1
            ? `${seasonLabel(Math.min(...result.seasonNumbers))}–${seasonLabel(Math.max(...result.seasonNumbers))} pack`
            : result.fullSeason
              ? `${seasonLabel(result.seasonNumber ?? result.mappedSeasonNumber ?? season ?? 0)} pack`
              : result.mappedEpisodeNumbers?.length
                ? result.mappedEpisodeNumbers
                    .map((n) =>
                      episodeLabel(result.mappedSeasonNumber ?? season ?? 0, n)
                    )
                    .join(',')
                : 'unmapped';
      const mapped =
        title.kind === 'series' &&
        result.mappedEpisodeNumbers?.length === 1 &&
        !(result.seasonNumbers && result.seasonNumbers.length > 1) &&
        !result.fullSeason
          ? library.episodes.find(
              (ep) =>
                ep.seasonNumber ===
                  (result.mappedSeasonNumber ?? season ?? 0) &&
                ep.episodeNumber === result.mappedEpisodeNumbers![0]
            )
          : undefined;
      lines.push(
        releaseLine(known, {
          what,
          reading: mapped
            ? nameReading(result.title, library.episodes, mapped)
            : readingOf(result.title, library),
          quality: result.quality?.quality.name,
          approved: result.approved,
          why: reasonsOf(result),
          failed: failed(release),
        })
      );
    }
    return `${results.length} results${earlier}${others}${
      results.length > MAX_LISTED_RELEASES
        ? `, the first ${MAX_LISTED_RELEASES} shown`
        : ''
    }:\n${lines.join('\n')}`;
  },
};

/**
 * An indexer (or Prowlarr) at its limit, told to the model in words with
 * when it can be asked again, so it tries another release or stops rather
 * than asking again at once.
 */
const atLimit = async <T>(ask: () => Promise<T>): Promise<T> => {
  try {
    return await ask();
  } catch (e) {
    if (e instanceof IndexerLimitReached) {
      throw new ToolError(
        `${limitHint(e)}. Use a release from another indexer, or leave it for now.`
      );
    }
    throw e;
  }
};

const searchIndexers: AgentTool = {
  name: 'search_indexers',
  readOnly: true,
  description:
    'Searches every Prowlarr indexer for any text, without Sonarr, Radarr or Lidarr filtering anything out. Use other names, years, "complete", "collection", a season, or the original title; for music (kind music), "Artist Album" or the album\'s name, with the year or FLAC.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      kind: { type: 'string', enum: ['series', 'movie', 'music'] },
    },
    required: ['query', 'kind'],
  },
  async run(state, input) {
    const { query, kind } = z
      .object({
        query: z.string().trim().min(2).max(200),
        kind: z.enum(['series', 'movie', 'music']),
      })
      .parse(input);
    const prowlarr = new ProwlarrAPI(getSettings().backfill.prowlarr);
    const categories =
      kind === 'music'
        ? AUDIO_CATEGORIES
        : kind === 'movie'
          ? MOVIE_CATEGORIES
          : TV_CATEGORIES;
    const results = await atLimit(() =>
      indexerLimits.guard(PROWLARR, 'search', () =>
        prowlarr.search(query, { categories })
      )
    );
    if (!results.length) return `Nothing for "${query}".`;
    // Usenet has no seeders; it is as good as a well-seeded torrent.
    const rank = (r: ProwlarrRelease) =>
      r.protocol === 'usenet' ? 50 : (r.seeders ?? 0);
    // Releases that failed for the title it is working on are marked.
    const bound = boundTitle(state.run);
    const failed = await failedReleases(bound);
    // Which episode of the series it works on each one is, by its name.
    const library =
      kind === 'series' && bound?.kind === 'series'
        ? await libraryOf(bound)
        : { episodes: [] as SonarrEpisode[], names: [] as string[] };
    const lines = [...results]
      .sort((a, b) => rank(b) - rank(a))
      .slice(0, MAX_LISTED_RELEASES)
      .map((release) =>
        releaseLine(remember(state, release, 'prowlarr'), {
          failed: failed(release),
          reading: readingOf(release.title, library),
        })
      );
    return `${results.length} results${
      results.length > MAX_LISTED_RELEASES
        ? `, the best ${MAX_LISTED_RELEASES} shown`
        : ''
    }:\n${lines.join('\n')}`;
  },
};

// ---- opening a release -------------------------------------------------------

const MAX_LISTED_FILES = 250;

const releaseOf = (state: AgentState, value: unknown): KnownRelease => {
  const known = state.releases.get(String(value ?? ''));
  if (!known) {
    throw new ToolError(
      'That is not a release reference from this run. Search first, then use its reference (like r3).'
    );
  }
  return known;
};

/**
 * A series' original language. Anime with none recorded is taken as
 * Japanese: its English dub may not exist, and the original is wanted.
 */
const originalOf = (series: {
  originalLanguage?: { name: string };
  seriesType?: string;
}): string | undefined =>
  series.originalLanguage?.name ??
  (series.seriesType === 'anime' ? 'Japanese' : undefined);

const filesOf = async (state: AgentState, known: KnownRelease) => {
  let files = state.files.get(known.ref);
  if (!files) {
    // Opening a release fetches it from its indexer, which counts toward
    // the indexer's download limit like any grab.
    const opened = await atLimit(() => backfill.filesOf(known));
    files = opened.files;
    if (opened.infoHash) known.infoHash = opened.infoHash;
    if (opened.packed) known.packed = opened.packed;
    state.files.set(known.ref, files);
  }
  return files;
};

const releaseFiles: AgentTool = {
  name: 'release_files',
  readOnly: true,
  description:
    "Opens a release and lists its files with their index, path and size, without downloading it. A magnet can take up to a minute. A Usenet post packed in archives or with scrambled file names can't be listed; one named as a single episode or the movie can be grabbed whole.",
  parameters: {
    type: 'object',
    properties: { release: { type: 'string', description: 'Like r3.' } },
    required: ['release'],
  },
  async run(state, input) {
    const known = releaseOf(state, input.release);
    const files = await filesOf(state, known);
    if (known.packed) {
      const what =
        known.packed === 'archives'
          ? 'packed in archives: its files are only known once it is downloaded and unpacked'
          : 'with scrambled file names (only its PAR2 repair files are named, which is common and fine): the Usenet client restores the real names once it is downloaded';
      return `${known.ref} "${known.title}" (${sizeOf(known.size)}) is a Usenet post ${what}. If its name is exactly one missing episode (or the movie), grab it whole: grab with whole: true and one file entry with index 0 and the season and episode its name gives. A season pack like this cannot be used.`;
    }
    const sorted = [...files].sort((a, b) => a.index - b.index);
    // For an album, what is not music is marked; for a series or a movie,
    // what is not video; before a title is chosen, what is neither.
    const kind = boundTitle(state.run)?.kind;
    const video = (f: PackFile) => isVideo(f.path) && f.size >= MIN_VIDEO_BYTES;
    const lines = sorted.slice(0, MAX_LISTED_FILES).map((f) => {
      const note =
        kind === 'album'
          ? isAudio(f.path)
            ? ''
            : ', not audio'
          : kind
            ? video(f)
              ? ''
              : ', not a video'
            : video(f) || isAudio(f.path)
              ? ''
              : ', not a video or audio';
      return `#${f.index}  ${f.path}  (${sizeOf(f.size)}${note})`;
    });
    return `${known.ref} "${known.title}": ${files.length} files\n${lines.join('\n')}${
      files.length > MAX_LISTED_FILES
        ? `\n… and ${files.length - MAX_LISTED_FILES} more`
        : ''
    }`;
  },
};

// ---- downloading -------------------------------------------------------------

const grabInput = z.object({
  title: z.string(),
  release: z.string(),
  files: z
    .array(
      z.object({
        index: z.coerce.number().int().min(0),
        season: z.coerce.number().int().min(0).optional(),
        episode: z.coerce.number().int().min(0).optional(),
        episodes: z
          .array(z.coerce.number().int().min(0))
          .min(1)
          .max(10)
          .optional(),
      })
    )
    .max(500)
    .default([]),
  reason: z.string().trim().min(3).max(600),
  certain: z.boolean().optional(),
  whole: z.boolean().optional(),
  replace: z.boolean().optional(),
});

export type GrabInput = z.infer<typeof grabInput>;

const ACTIVE_JOB: BackfillJob['status'][] = [
  'queued',
  'downloading',
  'importing',
  'paused',
];

/**
 * What became of this release for this title before. One an admin turned
 * down, or that failed to download, is not taken again. One downloaded
 * before may be taken again for other episodes (a full-series pack used
 * for one season, then another): a download of it still under way takes
 * the new files on, and episodes it did not import before are refused.
 */
const earlierUse = async (seriesId: number, known: KnownRelease) => {
  const earlier = (
    await getRepository(BackfillCandidate).find({
      where: { seriesId, status: In(['approved', 'dead', 'skipped']) },
    })
  ).filter(
    (c) =>
      c.guid === known.guid ||
      (!!known.infoHash && c.infoHash === known.infoHash.toLowerCase()) ||
      // The same post found again on another indexer failed the same way.
      (c.status === 'dead' && sameRelease(c, known))
  );
  if (earlier.some((c) => c.status === 'skipped')) {
    throw new ToolError(
      'An admin turned this release down for this title. Choose another.'
    );
  }
  const dead = earlier.find((c) => c.status === 'dead');
  if (dead) {
    throw new ToolError(
      `This release failed to download for this title before${
        dead.reason ? ` (${dead.reason})` : ''
      }. Choose another.`
    );
  }
  const jobs = earlier.length
    ? await getRepository(BackfillJob).find({
        where: { candidateId: In(earlier.map((c) => c.id)) },
        order: { id: 'DESC' },
      })
    : [];
  const running = jobs.find((job) => ACTIVE_JOB.includes(job.status));
  if (
    running &&
    running.status !== 'queued' &&
    running.status !== 'downloading'
  ) {
    throw new ToolError(
      `Backfill job #${running.id} is ${running.status} from this release now; once it is done, the release can be taken again for other episodes.`
    );
  }
  const importFailed = new Map<number, number>();
  for (const job of jobs) {
    if (ACTIVE_JOB.includes(job.status)) continue;
    for (const file of job.files) {
      if (file.state !== 'failed') continue;
      for (const id of file.episodeIds) importFailed.set(id, job.id);
    }
  }
  return { running, used: jobs.length > 0, importFailed };
};

const hasFileRefusal = (state: AgentState) =>
  mayReplace(state.run)
    ? 'The movie already has a file. To replace it, call grab again with replace: true; the admin is asked to approve first, and the old file goes only once the new one has imported.'
    : 'The movie already has a file; it is never replaced.';

/**
 * A movie is only downloaded while Radarr is monitoring it, as episodes are
 * only while Sonarr is: one not monitored is not wanted. Replacing the file
 * of one an admin asked about is the exception, as for episodes.
 */
const wantedMovie = (
  movie: RadarrMovieDetail,
  args: Pick<GrabInput, 'replace'>
) => movie.monitored || (!!args.replace && movie.hasFile);

const notMonitored = (movie: RadarrMovieDetail) =>
  `${movie.title} is not monitored in Radarr, so it is not wanted.`;

/** A download checked against every rule, not yet started. */
interface PreparedGrab {
  title: TitleRef;
  known: KnownRelease;
  row: BackfillSeries;
  name: string;
  plan: PlanEntry[];
  bytes: number;
  /** "S01E01 Wendle's Picnic Below The Pier", per plan entry. */
  targets: string[];
  /** What could make it wrong, for an admin to judge. */
  doubts: string[];
  /** A download of this same release under way, to take these files on. */
  extend?: BackfillJob;
}

/**
 * A Usenet post packed in archives or with scrambled names, taken whole:
 * what is inside is only known once the Usenet client has it, so its name
 * has to be the proof. Sonarr (or Radarr) must read the name as exactly
 * this one missing episode (or this movie), in a language that is wanted;
 * its one video is imported as that episode. For a series Sonarr numbers by
 * scene numbering, a name numbered the library's way counts too, when it
 * carries the episode's own title.
 */
const prepareWhole = async (
  state: AgentState,
  args: GrabInput,
  ctx: {
    title: TitleRef;
    known: KnownRelease;
    row: BackfillSeries;
    backfilling: Map<number, number>;
  }
): Promise<PreparedGrab> => {
  const { title, known, row, backfilling } = ctx;
  const settings = getSettings().backfill;
  if (args.files.length !== 1) {
    throw new ToolError(
      'A release taken whole is for one episode (or the movie): give one file entry, index 0.'
    );
  }
  const wanted = args.files[0];
  const entry: PlanEntry = {
    index: 0,
    path: known.title,
    size: known.size,
    judgedAs: known.title,
    episodeIds: [],
    score: 0,
    action: 'fill',
    replaces: 0,
    matchedBy: 'ai',
    why: args.reason,
    whole: true,
  };
  let name = row.title;
  let target: string;
  if (title.kind === 'movie') {
    const movieCtx = await backfill.movieContext(row);
    const movie = movieCtx.movie;
    name = movie.title;
    if (movie.hasFile && !args.replace) {
      throw new ToolError(hasFileRefusal(state));
    }
    if (!wantedMovie(movie, args)) {
      throw new ToolError(notMonitored(movie));
    }
    if (await movieCtx.radarr.getMovieQueueCount(movie.id)) {
      throw new ToolError('The movie is already downloading in Radarr.');
    }
    const parsed = await movieCtx.radarr.parse(known.title).catch(() => null);
    if (parsed?.movie?.id !== movie.id) {
      throw new ToolError(
        `Radarr does not read "${known.title}" as ${movie.title} (${movie.year}), so it cannot be taken unopened. Choose a release that can be opened.`
      );
    }
    const problem = languageProblem(
      parsed.languages,
      movie.originalLanguage?.name
    );
    if (problem) throw new Refused(problem);
    Object.assign(entry, {
      // A movie's plan entry carries the movie's id, as Backfill's own do.
      episodeIds: [movie.id],
      quality: parsed.parsedMovieInfo?.quality ?? UNKNOWN_QUALITY,
      languages: parsed.languages ?? [],
      releaseGroup: parsed.parsedMovieInfo?.releaseGroup,
      score: parsed.customFormatScore ?? 0,
      ...(movie.hasFile ? { action: 'upgrade' as const, replaces: 1 } : {}),
    });
    target = `${movie.title} (${movie.year})`;
  } else {
    const seriesCtx = await backfill.context(row);
    const series = seriesCtx.series;
    name = series.title;
    const parsed = await seriesCtx.sonarr.parse(known.title).catch(() => null);
    const info = parsed?.parsedEpisodeInfo;
    const read = parsed?.episodes ?? [];
    if (parsed?.series?.id !== series.id) {
      throw new ToolError(
        `Sonarr does not read "${known.title}" as ${series.title}, so it cannot be taken unopened. Choose a release that can be opened.`
      );
    }
    if (info?.fullSeason || info?.isMultiSeason || read.length !== 1) {
      throw new ToolError(
        `Sonarr reads "${known.title}" as ${
          info?.fullSeason || info?.isMultiSeason
            ? 'a season pack'
            : read.length
              ? `${read.length} episodes`
              : 'no episode it knows'
        }. Only a release that is exactly one episode can be taken unopened; for more, choose a release that can be opened.`
      );
    }
    // The episode it is: Sonarr's reading, unless Sonarr reads the name by
    // scene numbering and the name, numbered the library's way, carries the
    // wanted episode's title. The title must not say another episode.
    const mapped = read[0];
    const wantedEp = seriesCtx.episodes.find(
      (ep) =>
        ep.seasonNumber === wanted.season && ep.episodeNumber === wanted.episode
    );
    const byTitle = episodeByTitle(known.title, seriesCtx.episodes);
    const sameAsWanted =
      wanted.season === mapped.seasonNumber &&
      wanted.episode === mapped.episodeNumber;
    const namedAsWanted =
      !!wantedEp &&
      info?.seasonNumber === wanted.season &&
      info?.episodeNumbers?.length === 1 &&
      info.episodeNumbers[0] === wanted.episode &&
      byTitle?.id === wantedEp.id;
    if (!sameAsWanted && !namedAsWanted) {
      throw new ToolError(
        `Sonarr reads "${known.title}" as ${episodeLabel(
          mapped.seasonNumber,
          mapped.episodeNumber
        )}, not ${episodeLabel(wanted.season ?? 0, wanted.episode ?? 0)}${
          byTitle
            ? `, and its title is ${episodeLabel(byTitle.seasonNumber, byTitle.episodeNumber)} "${byTitle.title ?? ''}"`
            : ''
        }. Nothing was started.`
      );
    }
    if (sameAsWanted && byTitle && byTitle.id !== mapped.id) {
      throw new ToolError(
        `Sonarr reads "${known.title}" as ${episodeLabel(
          mapped.seasonNumber,
          mapped.episodeNumber
        )}, but its title is ${episodeLabel(byTitle.seasonNumber, byTitle.episodeNumber)} "${byTitle.title ?? ''}". Nothing was started.`
      );
    }
    const episode = sameAsWanted ? mapped : wantedEp!;
    const queued = new Set(
      await seriesCtx.sonarr
        .getSeriesQueueEpisodes(series.id)
        .catch(() => [] as number[])
    );
    // The same checks as for an opened release, the post standing in for
    // its one file.
    const { problems } = checkMapping(
      [
        {
          index: 0,
          season: episode.seasonNumber,
          episode: episode.episodeNumber,
        },
      ],
      [{ index: 0, path: `${known.title}.mkv`, size: known.size }],
      seriesCtx.episodes,
      {
        queued,
        backfilling,
        isVideo: () => true,
        replace: args.replace,
        canReplace: mayReplace(state.run),
      }
    );
    if (problems.length) {
      throw new ToolError(`Nothing was started. ${problems.join(' ')}`);
    }
    const problem = languageProblem(parsed.languages, originalOf(series));
    if (problem) throw new Refused(problem);
    const full = seriesCtx.episodes.find((e) => e.id === episode.id);
    Object.assign(entry, {
      episodeIds: [episode.id],
      season: episode.seasonNumber,
      episode: episode.episodeNumber,
      quality: info?.quality ?? UNKNOWN_QUALITY,
      languages: parsed.languages ?? [],
      releaseGroup: info?.releaseGroup,
      score: parsed.customFormatScore ?? 0,
      ...(full?.hasFile ? { action: 'upgrade' as const, replaces: 1 } : {}),
    });
    target = `${episodeLabel(episode.seasonNumber, episode.episodeNumber)} ${
      full?.title ?? ''
    }`.trim();
  }
  if (known.size > settings.agent.maxSizeGb * 1024 ** 3) {
    throw new ToolError(
      `That is ${sizeOf(known.size)}, over the ${settings.agent.maxSizeGb} GB limit for one download. Choose a smaller release.`
    );
  }
  return {
    title,
    known,
    row,
    name,
    plan: [entry],
    bytes: known.size,
    targets: [target],
    doubts: [],
  };
};

/**
 * An album's release: Backfill matches its files to the album's tracks,
 * in the edition Lidarr imports into, as it does for packs it finds
 * itself. What fills a missing track is taken (and, when replacing was
 * asked for, what Lidarr's profile prefers to a track on disk); the files
 * chosen, when any are given, narrow that.
 */
const prepareAlbum = async (
  state: AgentState,
  args: GrabInput,
  ctx: {
    title: TitleRef;
    known: KnownRelease;
    row: BackfillSeries;
    files: PackFile[];
    before: Awaited<ReturnType<typeof earlierUse>>;
  }
): Promise<PreparedGrab> => {
  const { title, known, row, files, before } = ctx;
  if (known.packed) {
    throw new ToolError(
      "This Usenet post can't be opened, so its files can't be matched to the album's tracks. Choose a release that can be opened."
    );
  }
  const album = await backfill.albumContext(row);
  const name = `${album.album.title} by ${album.artist.artistName}`;
  if (!album.album.monitored && !args.replace) {
    throw new ToolError(
      `${name} is not monitored in Lidarr, so it is not wanted.`
    );
  }
  if (await album.lidarr.getAlbumQueueCount(album.album.id).catch(() => 0)) {
    throw new ToolError('The album is already downloading in Lidarr.');
  }
  const { plan: judged } = await judgeAlbumPack(files, known.title, album);
  const chosen = new Set(args.files.map((f) => f.index));
  const wanted = judged.filter(
    (e) =>
      (e.action === 'fill' || (!!args.replace && e.action === 'upgrade')) &&
      (!chosen.size || chosen.has(e.index)) &&
      !e.episodeIds.some((id) => before.importFailed.has(id))
  );
  if (!wanted.length) {
    const reasons = new Map<string, number>();
    for (const e of judged) {
      if (e.action === 'fill') continue;
      const why =
        e.action === 'upgrade'
          ? 'would replace a track on disk'
          : (e.reason ?? e.action);
      reasons.set(why, (reasons.get(why) ?? 0) + 1);
    }
    const failedBefore = judged.filter((e) =>
      e.episodeIds.some((id) => before.importFailed.has(id))
    ).length;
    throw new ToolError(
      `Nothing was started: nothing in "${known.title}" fills a missing track of ${name}${
        reasons.size
          ? ` (${[...reasons]
              .map(([why, n]) => `${n} ${n === 1 ? 'file' : 'files'}: ${why}`)
              .slice(0, 6)
              .join('; ')})`
          : ''
      }${
        failedBefore
          ? `; ${failedBefore} did not import from this release before`
          : ''
      }. Choose another release.`
    );
  }
  const trackOf = new Map([...album.tracks].map((t) => [t.id, t] as const));
  const plan = wanted.map((e) => ({ ...e, why: args.reason }));
  const targets = plan.map((e) => {
    const track = trackOf.get(e.episodeIds[0]);
    return `Track ${e.episode ?? '?'}${track ? ` "${track.title}"` : ''}`;
  });
  const bytes = plan.reduce((n, e) => n + e.size, 0);
  if (bytes > getSettings().backfill.agent.maxSizeGb * 1024 ** 3) {
    throw new ToolError(
      `That is ${sizeOf(bytes)}, over the ${getSettings().backfill.agent.maxSizeGb} GB limit for one download. Choose a smaller release.`
    );
  }
  return {
    title,
    known,
    row,
    name,
    plan,
    bytes,
    targets,
    doubts: [],
    extend: before.running,
  };
};

/**
 * Checks a download against every rule and builds what Backfill needs,
 * without starting anything. Throws why it cannot be done at all; lists
 * what makes it doubtful, which only an admin can wave through.
 */
const prepareGrab = async (
  state: AgentState,
  args: GrabInput
): Promise<PreparedGrab> => {
  if (args.replace && !mayReplace(state.run)) {
    throw new ToolError(
      'Files are replaced only when an admin asks for it. Fill what is missing instead.'
    );
  }
  const title = readTitleRef(args.title);
  const known = releaseOf(state, args.release);
  if (title.kind !== 'album' && !args.files.length) {
    throw new ToolError(
      'Give the files to fetch, by their index from release_files.'
    );
  }
  if (title.kind === 'album' && !musicOn()) {
    throw new ToolError(
      'Backfill does not do music now (Music too in Settings → Backfill), so albums cannot be downloaded.'
    );
  }
  const settings = getSettings().backfill;
  const group = blockedGroupOf(known.title);
  if (group) {
    throw new ToolError(
      `${group} is a blocked release group. Choose another release.`
    );
  }
  const ready = backfill.readiness();
  if (!ready.ready) throw new ToolError(ready.problem ?? 'Backfill is off.');
  if (state.grabsToday >= settings.agent.maxGrabsPerDay) {
    throw new ToolError(
      `The limit of ${settings.agent.maxGrabsPerDay} downloads a day is reached. Say what you would grab instead.`
    );
  }
  const files = await filesOf(state, known);
  // What an admin asked for is theirs to keep in Backfill.
  const row = await backfill.track(
    title.kind,
    title.serverId,
    title.arrId,
    adminPresent(state.run)
  );
  // Downloads already under way for the title: another can run beside
  // them, for other episodes.
  const running = await getRepository(BackfillJob).find({
    where: {
      seriesId: row.id,
      status: In(['queued', 'downloading', 'importing', 'paused']),
    },
  });
  if (running.length && title.kind !== 'series') {
    throw new ToolError(
      `Backfill job #${running[0].id} is already downloading this ${title.kind}.`
    );
  }
  const backfilling = new Map<number, number>();
  for (const job of running) {
    for (const file of job.files) {
      for (const id of file.episodeIds) backfilling.set(id, job.id);
    }
  }
  const before = await earlierUse(row.id, known);
  if (title.kind !== 'series' && before.used && !before.running) {
    throw new ToolError(
      `This release was downloaded for this ${title.kind} before and did not import. Choose another.`
    );
  }
  if (title.kind === 'album') {
    return prepareAlbum(state, args, { title, known, row, files, before });
  }

  const titleLanguage = async (original?: string) =>
    languageProblem(
      (
        await (
          title.kind === 'movie'
            ? backfill.radarrFor(title.serverId).parse(known.title)
            : backfill.sonarrFor(title.serverId).parse(known.title)
        ).catch(() => null)
      )?.languages,
      original
    );

  if (args.whole || known.packed) {
    if (!known.packed) {
      throw new ToolError(
        'whole is only for a Usenet post packed in archives or with scrambled names (release_files says so). Choose its files from release_files.'
      );
    }
    if (before.running) {
      throw new ToolError(
        `Backfill job #${before.running.id} is already downloading this release.`
      );
    }
    return prepareWhole(state, args, { title, known, row, backfilling });
  }

  const plan: PlanEntry[] = [];
  const targets: string[] = [];
  const doubts: string[] = [];
  let name = row.title;
  if (title.kind === 'movie') {
    const ctx = await backfill.movieContext(row);
    name = ctx.movie.title;
    if (ctx.movie.hasFile && !args.replace) {
      throw new ToolError(hasFileRefusal(state));
    }
    if (!wantedMovie(ctx.movie, args)) {
      throw new ToolError(notMonitored(ctx.movie));
    }
    if (await ctx.radarr.getMovieQueueCount(ctx.movie.id)) {
      throw new ToolError('The movie is already downloading in Radarr.');
    }
    if (args.files.length !== 1) {
      throw new ToolError('Choose exactly one file for a movie.');
    }
    const file = files.find((f) => f.index === args.files[0].index);
    if (!file || !isVideo(file.path) || file.size < MIN_VIDEO_BYTES) {
      throw new ToolError(
        `File #${args.files[0].index} is not a video in this release.`
      );
    }
    const original = ctx.movie.originalLanguage?.name;
    const releaseProblem = await titleLanguage(original);
    if (releaseProblem) throw new Refused(releaseProblem);
    if (!mentionsShow(known.title, ctx.names)) {
      doubts.push(`The release's name does not name ${ctx.movie.title}.`);
    }
    const judgedAs = movieName({
      fileName: baseName(file.path),
      packTitle: known.title,
      title: ctx.movie.title,
      year: ctx.movie.year,
    });
    const parsed = await ctx.radarr.parse(judgedAs).catch(() => null);
    const problem = languageProblem(parsed?.languages, original);
    if (problem) throw new Refused(problem);
    plan.push({
      index: file.index,
      path: file.path,
      size: file.size,
      judgedAs,
      // The movie's id, as Backfill's own plans carry it: what is on disk
      // is checked by it before the download starts.
      episodeIds: [ctx.movie.id],
      quality: parsed?.parsedMovieInfo?.quality ?? UNKNOWN_QUALITY,
      languages: parsed?.languages ?? [],
      releaseGroup: parsed?.parsedMovieInfo?.releaseGroup,
      score: parsed?.customFormatScore ?? 0,
      action: ctx.movie.hasFile ? 'upgrade' : 'fill',
      replaces: ctx.movie.hasFile ? 1 : 0,
      matchedBy: 'ai',
      why: args.reason,
    });
    targets.push(`${ctx.movie.title} (${ctx.movie.year})`);
  } else {
    const ctx = await backfill.context(row);
    name = ctx.series.title;
    const queued = new Set(
      await ctx.sonarr
        .getSeriesQueueEpisodes(ctx.series.id)
        .catch(() => [] as number[])
    );
    const { ok, problems } = checkMapping(args.files, files, ctx.episodes, {
      queued,
      backfilling,
      importFailed: before.importFailed,
      isVideo,
      replace: args.replace,
      canReplace: mayReplace(state.run),
    });
    if (problems.length) {
      throw new ToolError(
        `Nothing was started. ${problems.slice(0, 12).join(' ')}${
          problems.length > 12 ? ` (${problems.length - 12} more)` : ''
        }`
      );
    }
    const original = originalOf(ctx.series);
    const releaseProblem = await titleLanguage(original);
    if (releaseProblem) throw new Refused(releaseProblem);
    if (!mentionsShow(known.title, ctx.names)) {
      doubts.push(`The release's name does not name ${ctx.series.title}.`);
    }
    for (const { file, episode, episodes } of ok) {
      const fileName = baseName(file.path);
      const season = episode.seasonNumber;
      const numbers = episodes.map((e) => e.episodeNumber);
      const label = rangeLabel(season, numbers);
      const full = episodes.map((e) => ctx.episodes.find((x) => x.id === e.id));
      const own = fileNumbers(fileName);
      const ownLast = own.through ?? own.episode;
      // A file named as several episodes is imported as all of them, or
      // Sonarr names it as the first and the rest stay missing.
      if (
        own.season === season &&
        own.episode === numbers[0] &&
        ownLast !== undefined &&
        ownLast !== numbers[numbers.length - 1]
      ) {
        const holds = Array.from(
          { length: ownLast - numbers[0] + 1 },
          (_, i) => numbers[0] + i
        );
        throw new ToolError(
          `Nothing was started. File #${file.index} "${fileName}" is ${rangeLabel(season, holds)} by its name, but it was given ${label}. Give it every episode it holds: episodes: [${holds.join(', ')}].`
        );
      }
      // A name carrying another episode's title is that episode, whatever
      // its number says: releases number seasons their own way (a special
      // counted as episode 1, scene seasons), and the title does not lie.
      const titled = episodeByTitle(fileName, ctx.episodes);
      if (titled && !episodes.some((e) => e.id === titled.id)) {
        throw new ToolError(
          `Nothing was started. File #${file.index} "${fileName}" is ${episodeLabel(
            titled.seasonNumber,
            titled.episodeNumber
          )} "${titled.title ?? ''}" by its title${
            titled.hasFile ? ', which is on disk' : ''
          }, not ${label} ${full
            .map((e) => `"${e?.title ?? ''}"`)
            .join(' + ')}. Map each file by its title, not its number.`
        );
      }
      const named =
        full.every((e) => namesEpisode(fileName, e?.title)) ||
        (numbers.length === 1
          ? numberedAs(own, {
              seasonNumber: season,
              episodeNumber: numbers[0],
              absoluteEpisodeNumber: full[0]?.absoluteEpisodeNumber,
            })
          : own.season === season &&
            own.episode === numbers[0] &&
            ownLast === numbers[numbers.length - 1]);
      if (!named) {
        doubts.push(
          `File #${file.index} "${fileName}" names neither ${label} ${full
            .map((e) => `"${e?.title ?? ''}"`)
            .join(' + ')} nor its number.`
        );
      }
      if (numbers.length > 1) {
        doubts.push(
          `File #${file.index} holds ${numbers.length} episodes (${label}). One file per episode is preferred: take files holding several episodes only when no release has these episodes one per file.`
        );
      }
      const judgedAs = canonicalName({
        fileName,
        packTitle: known.title,
        seriesTitle: ctx.series.title,
        number: {
          season,
          episode: numbers[0],
          ...(numbers.length > 1
            ? { through: numbers[numbers.length - 1] }
            : {}),
        },
      });
      const parsed = await ctx.sonarr.parse(judgedAs).catch(() => null);
      const problem = languageProblem(parsed?.languages, original);
      if (problem) {
        // One file of a pack: the rest may be fine.
        throw new ToolError(`File #${file.index}: ${problem}`);
      }
      plan.push({
        index: file.index,
        path: file.path,
        size: file.size,
        judgedAs,
        episodeIds: episodes.map((e) => e.id),
        season,
        episode: numbers[0],
        quality: parsed?.parsedEpisodeInfo?.quality ?? UNKNOWN_QUALITY,
        languages: parsed?.languages ?? [],
        releaseGroup: parsed?.parsedEpisodeInfo?.releaseGroup,
        score: parsed?.customFormatScore ?? 0,
        action: episodes.some((e) => e.hasFile) ? 'upgrade' : 'fill',
        replaces: episodes.filter((e) => e.hasFile).length,
        matchedBy: 'ai',
        why: args.reason,
      });
      targets.push(
        `${label} ${full.map((e) => e?.title ?? '').join(' + ')}`.trim()
      );
    }
  }

  const bytes = plan.reduce((n, e) => n + e.size, 0);
  if (bytes > settings.agent.maxSizeGb * 1024 ** 3) {
    throw new ToolError(
      `That is ${sizeOf(bytes)}, over the ${settings.agent.maxSizeGb} GB limit for one download. Choose fewer files or a smaller release.`
    );
  }
  return {
    title,
    known,
    row,
    name,
    plan,
    bytes,
    targets,
    doubts,
    extend: before.running,
  };
};

/** Starts a prepared download through Backfill and records it. */
const commitGrab = async (
  state: AgentState,
  prepared: PreparedGrab,
  by: string
): Promise<string> => {
  const { title, known, row, name, plan, bytes } = prepared;
  const labels =
    title.kind === 'movie'
      ? 'the movie'
      : title.kind === 'album'
        ? plan.length === 1
          ? '1 track'
          : `${plan.length} tracks`
        : plan
            .map((e) =>
              rangeLabel(
                e.season ?? 0,
                e.episodeIds.map((_, i) => (e.episode ?? 0) + i)
              )
            )
            .join(', ');
  const files = `${plan.length === 1 ? '1 file' : `${plan.length} files`} (${sizeOf(bytes)})`;
  const replaces = plan.some((e) => e.action === 'upgrade');
  if (prepared.extend && replaces) {
    throw new ToolError(
      `Backfill job #${prepared.extend.id} is downloading this release now; files can be replaced from it once that is done.`
    );
  }
  if (prepared.extend) {
    const job = await backfill
      .extendJob(prepared.extend.id, plan, by)
      .catch((e: unknown) => {
        throw new ToolError(e instanceof Error ? e.message : String(e));
      });
    state.grabsToday += 1;
    state.bind(title, name);
    state.act({
      at: new Date().toISOString(),
      type: 'grab',
      title: name,
      detail: `${files} more from "${known.title}" for ${labels}, added to Backfill job #${job.id}`,
      jobId: job.id,
      extended: true,
      episodeIds: plan.flatMap((e) => e.episodeIds),
      release: known.title,
    });
    return `Added to Backfill job #${job.id}, which is already downloading this release: ${plan.length} files, ${sizeOf(bytes)}, for ${labels}. They are fetched and imported with the rest of it.`;
  }
  const candidate = await getRepository(BackfillCandidate).save(
    new BackfillCandidate({
      seriesId: row.id,
      guid: known.guid,
      title: known.title,
      indexer: known.indexer,
      indexerId: known.indexerId,
      protocol: known.protocol,
      size: known.size,
      seeders: known.seeders ?? null,
      publishDate: known.publishDate ?? null,
      downloadUrl: known.downloadUrl ?? null,
      magnetUrl: known.magnetUrl ?? null,
      infoHash: known.infoHash?.toLowerCase() ?? null,
      status: 'ready',
      reason: null,
      plan,
      summary: summarize(plan),
      // Taken at once: nobody needs telling it is waiting.
      notifiedAt: new Date(),
    })
  );
  const job = await backfill.approve(candidate.id, {
    // Replacing was approved by an admin before this point.
    mode: replaces ? 'all' : 'missing',
    includeAi: true,
    by,
    // Should it fail, the conversation is told, to look for another.
    agentRunId: state.run.id,
  });
  state.grabsToday += 1;
  state.bind(title, name);
  state.act({
    at: new Date().toISOString(),
    type: 'grab',
    title: name,
    detail: `${files} from "${known.title}" for ${labels}${
      replaces ? ', replacing what is there once imported' : ''
    }`,
    jobId: job.id,
    episodeIds: plan.flatMap((e) => e.episodeIds),
    release: known.title,
  });
  return `Started Backfill job #${job.id}: ${plan.length} files, ${sizeOf(bytes)}, for ${labels}. Backfill downloads only these files and has ${
    title.kind === 'movie'
      ? 'Radarr'
      : title.kind === 'album'
        ? 'Lidarr'
        : 'Sonarr'
  } import each as mapped${
    replaces
      ? '; a file already there is replaced only once its new one has imported'
      : ''
  }.${
    job.indexerWait
      ? ` For now it waits: ${job.stage}; Backfill tries again by itself, so do not grab it again.`
      : ''
  }`;
};

/**
 * A replacing grab, for an admin to approve: what goes and what comes. On
 * approval it is checked again from scratch and started.
 */
const replaceProposal = (
  prepared: PreparedGrab,
  args: GrabInput
): ProposedChange => {
  const { title, known, name, plan, targets, bytes } = prepared;
  const replaced = plan.filter((e) => e.action === 'upgrade');
  const app =
    title.kind === 'movie'
      ? 'Radarr'
      : title.kind === 'album'
        ? 'Lidarr'
        : 'Sonarr';
  return {
    kind: 'replace',
    headline:
      title.kind === 'movie'
        ? `Replace the file of ${name}`
        : title.kind === 'album'
          ? `Replace ${replaced.length === 1 ? 'a track' : `${replaced.length} tracks`} of ${name}`
          : `Replace ${replaced.length === 1 ? 'a file' : `${replaced.length} files`} of ${name}`,
    title,
    details: [
      `Downloads "${known.title}" (${sizeOf(bytes)}, ${known.indexer}) through Backfill, only the files chosen.`,
      `For: ${targets.slice(0, 12).join('; ')}${targets.length > 12 ? ` and ${targets.length - 12} more` : ''}.`,
      `${app} imports each new file over the one there; until it has, the old file stays and can still be played.`,
      ...(prepared.doubts.length
        ? [`Doubts the agent waved through: ${prepared.doubts.join(' ')}`]
        : []),
      `Why: ${args.reason}`,
    ],
    params: { grab: { ...args, certain: true } },
  };
};

const grab: AgentTool = {
  name: 'grab',
  description:
    "Downloads chosen files of a release through Backfill and imports each as the episode you map it to (or as the movie). It only fills episodes with no file and never replaces one. One file per episode is preferred: take a release whose files each hold several episodes only when none has them one per file, and then give each such file all its episodes. Map files by comparing file titles with episode titles: a collection may number files its own way. If a file names neither its episode title nor its number, you are asked to look again; call it again with certain: true only once you are sure. A pack used before for other episodes (one season of a full-series pack) can be taken again for the rest; while it is still downloading, the new files join that download. For an album, give no files: Backfill matches the release's files to the album's tracks itself and takes those that fill missing tracks, or says why none do.",
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'A title reference.' },
      release: { type: 'string', description: 'Like r3.' },
      files: {
        type: 'array',
        description:
          'Each file to fetch, by index from release_files, with the season and episode it is. A file holding several episodes (S06E01-02, "Title A + Title B") gets every one of them in episodes instead, like episodes: [1, 2]; Sonarr then names it S06E01-E02. For a movie, one file and no season or episode. For an album, leave it out (or give only indexes, to take just those files).',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            season: { type: 'integer' },
            episode: { type: 'integer' },
            episodes: {
              type: 'array',
              items: { type: 'integer' },
              description:
                'Every episode a file holds, in a row, when it holds several.',
            },
          },
          required: ['index'],
        },
      },
      reason: {
        type: 'string',
        description: 'Why this release and this mapping are right.',
      },
      certain: {
        type: 'boolean',
        description:
          'Only after it said to look again, and you did, and you are sure.',
      },
      whole: {
        type: 'boolean',
        description:
          'For a Usenet post packed in archives or with scrambled names (release_files says so) whose name is exactly one missing episode or the movie: takes it whole. Give one file entry, index 0, with the season and episode.',
      },
      replace: {
        type: 'boolean',
        description:
          'Only when the admin (or the report) asked for a file to be replaced: lets episodes (or a movie) that have a file be mapped. Nothing starts until the admin approves; the old file goes only once the new one has imported.',
      },
    },
    required: ['title', 'release', 'reason'],
  },
  async run(state, input) {
    const args = grabInput.parse(input);
    const prepared = await prepareGrab(state, args);
    if (prepared.doubts.length && !args.certain) {
      throw new ToolError(
        `Not started. Look again: ${prepared.doubts.slice(0, 8).join(' ')} Check the file names against the episode titles (and the release against the show). If you are sure it is right, call grab again with certain: true; if not, choose another release, or ask the admin.`
      );
    }
    if (prepared.plan.some((e) => e.action === 'upgrade')) {
      if (prepared.extend) {
        throw new ToolError(
          `Backfill job #${prepared.extend.id} is downloading this release now; files can be replaced from it once that is done.`
        );
      }
      state.propose(replaceProposal(prepared, args));
      return "Not started yet: replacing files needs the admin's approval, and they have been asked. Stop here; you hear what they decided next.";
    }
    return commitGrab(state, prepared, 'AI agent');
  },
};

const askAdmin: AgentTool = {
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

const stopDownload: AgentTool = {
  name: 'stop_download',
  description:
    'Stops a Backfill download this conversation started, when the admin says it is wrong or you find it is: the download and its partial files are removed. Files already imported stay; say so if any were.',
  parameters: {
    type: 'object',
    properties: {
      job: { type: 'integer', description: 'The Backfill job number.' },
      reason: { type: 'string' },
    },
    required: ['job', 'reason'],
  },
  async run(state, input) {
    const { job: id, reason } = z
      .object({
        job: z.coerce.number().int().min(1),
        reason: z.string().trim().min(3).max(600),
      })
      .parse(input);
    // Only a download it started: one it added files to was someone
    // else's, and ending it would take their files with it.
    const grabs = state.run.actions.filter(
      (a) => a.type === 'grab' && a.jobId === id
    );
    if (!grabs.some((a) => !a.extended)) {
      throw new ToolError(
        `Job #${id} was not started in this conversation${
          grabs.length ? ' (it only added files to it)' : ''
        }, so it is not yours to stop. The admin can end it on its Backfill page.`
      );
    }
    const job = await getRepository(BackfillJob).findOne({ where: { id } });
    if (!job) throw new ToolError(`There is no job #${id}.`);
    if (['done', 'failed', 'cancelled'].includes(job.status)) {
      return `Job #${id} is already ${job.status}; ${job.imported} files were imported.`;
    }
    if (job.status === 'importing') {
      throw new ToolError(
        `Job #${id} is importing right now; wait a minute and look at it again.`
      );
    }
    await backfill.end(id, state.user);
    state.act({
      at: new Date().toISOString(),
      type: 'stop',
      title: job.title,
      detail: `Stopped download #${id}: ${reason}`,
      jobId: id,
    });
    return `Stopped job #${id}; ${job.imported} of its files had been imported.`;
  },
};

/** Words in names that say what language a release or file is in. */
const LANGUAGE_TAGS =
  /\b(multi|dual[ .-]?audio|dubbed|dub|subbed|vostfr|truefrench|french|vf[fiq]?|german|deutsch|ita|italian|spanish|castellano|latino|portuguese|pt-?br|russian|rus|polish|pl|hindi|tamil|telugu|japanese|jpn|korean|chinese|nordic|swedish|danish|norwegian|dutch|nl|turkish|arabic|eng(lish)?)\b/gi;

const checkLanguage: AgentTool = {
  name: 'check_language',
  readOnly: true,
  description:
    "Gathers what can be told about a release's language before downloading: what Sonarr or Radarr reads from its name and from each file's name, language words in the names (MULTi, DUAL AUDIO, iTA, TRUEFRENCH…), and any subtitle files in it. The audio itself can only be read once a file is downloaded; title_status shows the audio language of files on disk.",
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'A title reference.' },
      release: { type: 'string', description: 'Like r3.' },
    },
    required: ['title', 'release'],
  },
  async run(state, input) {
    const title = readTitleRef(input.title);
    if (title.kind === 'album') {
      throw new ToolError(
        "Music has no audio language to check: an album is the artist's own recording."
      );
    }
    const known = releaseOf(state, input.release);
    const parse = (name: string) =>
      (title.kind === 'movie'
        ? backfill.radarrFor(title.serverId).parse(name)
        : backfill.sonarrFor(title.serverId).parse(name)
      ).catch(() => null);
    const named = (await parse(known.title))?.languages ?? [];
    const files = await filesOf(state, known).catch(() => null);
    const tags = new Map<string, number>();
    const subtitles: string[] = [];
    for (const name of [known.title, ...(files ?? []).map((f) => f.path)]) {
      for (const tag of name.match(LANGUAGE_TAGS) ?? []) {
        const key = tag.toLowerCase();
        tags.set(key, (tags.get(key) ?? 0) + 1);
      }
    }
    for (const file of files ?? []) {
      if (/\.(srt|ass|ssa|sub|idx|vtt)$/i.test(file.path)) {
        subtitles.push(baseName(file.path));
      }
    }
    const videos = (files ?? []).filter(
      (f) => isVideo(f.path) && f.size >= MIN_VIDEO_BYTES
    );
    const sample = await Promise.all(
      videos.slice(0, 5).map(async (f) => {
        const langs = (await parse(baseName(f.path)))?.languages ?? [];
        return `${baseName(f.path)}: ${
          langs.map((l) => l.name).join(', ') || 'nothing said'
        }`;
      })
    );
    return [
      `Release name reads as: ${named.map((l) => l.name).join(', ') || 'nothing said'}.`,
      tags.size
        ? `Language words in the names: ${[...tags]
            .map(([tag, n]) => `${tag} ×${n}`)
            .join(', ')}.`
        : 'No language words in the release or file names.',
      files
        ? `Subtitle files: ${subtitles.length ? subtitles.slice(0, 10).join(', ') : 'none'}.`
        : 'Its files could not be listed.',
      sample.length ? `File names read as:\n${sample.join('\n')}` : '',
      'Nothing here hears the audio: a name that says nothing is most often in the original language, but only a downloaded file proves it.',
    ]
      .filter(Boolean)
      .join('\n');
  },
};

const relinkFile: AgentTool = {
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

/** A library title's name, as Sonarr, Radarr or Lidarr has it. */
const nameOf = async (title: TitleRef): Promise<string> =>
  title.kind === 'album'
    ? albumName(title)
    : title.kind === 'movie'
      ? (await backfill.radarrFor(title.serverId).getMovieDetail(title.arrId))
          .title
      : (await backfill.sonarrFor(title.serverId).getSeriesDetail(title.arrId))
          .title;

const CHANGE_KINDS = [
  'blockGroup',
  'unblockGroup',
  'markFailed',
  'deleteFiles',
  'changeProfile',
] as const;

const proposeChange: AgentTool = {
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

const replaceSeason: AgentTool = {
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

const searchUpgrade: AgentTool = {
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

/**
 * Starts a replacing grab an admin approved: everything is checked again
 * as it is now, and the files taken only if it all still holds.
 */
export const startApprovedGrab = async (
  state: AgentState,
  input: unknown,
  by: string
): Promise<string> => {
  const args = grabInput.parse(input);
  const prepared = await prepareGrab(state, { ...args, replace: true });
  return commitGrab(state, prepared, by);
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

const requestTitle: AgentTool = {
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

export const TOOLS: AgentTool[] = [
  findTitle,
  titleStatus,
  searchReleases,
  searchIndexers,
  releaseFiles,
  checkLanguage,
  grab,
  stopDownload,
  relinkFile,
  askAdmin,
  requestTitle,
  searchUpgrade,
  replaceSeason,
  proposeChange,
];

/**
 * Why a run with no admin in it may not use a tool on this title, or null.
 * Such a run (started on its own, or for someone's report) is about its one
 * title: what it reads (release names, file paths) cannot send it to work
 * on another.
 */
const elsewhere = (
  run: AgentRun,
  input: Record<string, unknown>
): string | null => {
  if (adminPresent(run) || run.arrId === null || run.arrId === undefined) {
    return null;
  }
  if (input.title === undefined) return null;
  let asked: TitleRef;
  try {
    asked = readTitleRef(input.title);
  } catch {
    // Not a reference at all: the tool says so itself.
    return null;
  }
  const own = titleRef({
    kind: run.kind ?? 'series',
    serverId: run.serverId ?? 0,
    arrId: run.arrId,
  });
  return titleRef(asked) === own
    ? null
    : `This conversation is only about ${run.title ?? 'its title'} (${own}). No admin is in it, so no other title is looked at or changed.`;
};

/** A tool call as the run made it, to tell what it has looked for. */
export interface MadeCall {
  name: string;
  input: Record<string, unknown>;
}

/** What one search's words name: episodes, whole seasons, numbers, text. */
interface SearchWords {
  episodes: Set<string>;
  seasons: Set<number>;
  /** Numbers standing alone ("Show 152", "[152]"), for anime. */
  numbers: Set<number>;
  text: string;
}

const readSearch = (query: string): SearchWords => {
  const episodes = new Set<string>();
  const seasons = new Set<number>();
  const numbers = new Set<number>();
  for (const m of query.matchAll(
    /(?:^|[^a-z0-9])s(\d{1,3})(?:[ ._-]?e(\d{1,4}))?(?=[^0-9]|$)|(?:^|[^0-9])(\d{1,2})x(\d{1,3})(?=[^0-9]|$)|\bseason (\d{1,3})\b/gi
  )) {
    if (m[1] !== undefined && m[2] !== undefined) {
      episodes.add(`${Number(m[1])}:${Number(m[2])}`);
    } else if (m[1] !== undefined) {
      seasons.add(Number(m[1]));
    } else if (m[3] !== undefined) {
      episodes.add(`${Number(m[3])}:${Number(m[4])}`);
    } else if (m[5] !== undefined) {
      seasons.add(Number(m[5]));
    }
  }
  // Standing alone: the 04 of S03E04 is not episode 4 overall.
  for (const m of query.matchAll(/(?:^|[\s#[(-])(\d{1,4})(?=[\s\])-]|$)/g)) {
    numbers.add(Number(m[1]));
  }
  return { episodes, seasons, numbers, text: normalize(query) };
};

/** Whether a search's words name this episode: its number, or its title. */
const searchNames = (
  words: SearchWords,
  ep: SonarrEpisode,
  anime: boolean
): boolean => {
  const title = normalize(ep.title ?? '');
  return (
    words.episodes.has(`${ep.seasonNumber}:${ep.episodeNumber}`) ||
    (ep.sceneSeasonNumber != null &&
      ep.sceneEpisodeNumber != null &&
      words.episodes.has(`${ep.sceneSeasonNumber}:${ep.sceneEpisodeNumber}`)) ||
    words.seasons.has(ep.seasonNumber) ||
    (anime &&
      ep.absoluteEpisodeNumber != null &&
      words.numbers.has(ep.absoluteEpisodeNumber)) ||
    (title.length >= 4 && ` ${words.text} `.includes(` ${title} `))
  );
};

/**
 * The missing episodes of the title a run works on that it has not looked
 * for at all: no search named them (by number or title, one by one or by
 * their season), nothing was started for them, and nothing is downloading
 * them. Empty for a movie, or when it cannot be told.
 */
export const notLookedFor = async (
  run: AgentRun,
  calls: MadeCall[]
): Promise<SonarrEpisode[]> => {
  const title = boundTitle(run);
  if (!title || title.kind !== 'series') return [];
  const sonarr = backfill.sonarrFor(title.serverId);
  const [series, episodes, queued, { jobs }] = await Promise.all([
    sonarr.getSeriesDetail(title.arrId),
    sonarr.getSeriesEpisodes(title.arrId),
    sonarr.getSeriesQueueEpisodes(title.arrId).catch(() => [] as number[]),
    backfillOf(title),
  ]);
  const busy = new Set<number>([
    ...queued,
    ...jobs.flatMap((job) => job.files.flatMap((f) => f.episodeIds)),
    ...run.actions.flatMap((a) => a.episodeIds ?? []),
  ]);
  // Each search read once, however many episodes there are.
  const anime = series.seriesType === 'anime';
  const seasonsSearched = new Set<number>();
  const episodesSearched = new Set<string>();
  const words: SearchWords[] = [];
  for (const call of calls) {
    if (call.name === 'search_releases') {
      const season = Number(call.input.season);
      if (call.input.episode === undefined) seasonsSearched.add(season);
      else episodesSearched.add(`${season}:${Number(call.input.episode)}`);
    } else if (call.name === 'search_indexers') {
      words.push(readSearch(String(call.input.query ?? '')));
    }
  }
  const looked = (ep: SonarrEpisode) =>
    seasonsSearched.has(ep.seasonNumber) ||
    episodesSearched.has(`${ep.seasonNumber}:${ep.episodeNumber}`) ||
    words.some((w) => searchNames(w, ep, anime));
  const now = Date.now();
  return episodes
    .filter(
      (ep) =>
        !ep.hasFile &&
        ep.monitored &&
        (!ep.airDateUtc || new Date(ep.airDateUtc).getTime() <= now) &&
        !busy.has(ep.id)
    )
    .filter((ep) => !looked(ep))
    .sort(
      (a, b) =>
        a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber
    );
};

/** Runs one tool for the model: its answer, or why it could not. */
export const runTool = async (
  state: AgentState,
  name: string,
  input: Record<string, unknown>
): Promise<{ text: string; isError: boolean; refused?: boolean }> => {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool || (tool.askOnly && !adminPresent(state.run))) {
    return { text: `There is no tool called ${name}.`, isError: true };
  }
  const refused = elsewhere(state.run, input);
  if (refused) return { text: refused, isError: true };
  try {
    return { text: clip(await tool.run(state, input)), isError: false };
  } catch (e) {
    const why =
      e instanceof z.ZodError
        ? `The input was not right: ${e.issues
            .map((i) => `${i.path.join('.')} ${i.message}`)
            .join('; ')}`
        : e instanceof Error
          ? e.message
          : String(e);
    return {
      text: clip(why, 1500),
      isError: true,
      ...(e instanceof Refused ? { refused: true } : {}),
    };
  }
};
