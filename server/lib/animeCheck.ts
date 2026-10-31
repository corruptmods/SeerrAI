import type { RadarrMovie } from '@server/api/servarr/radarr';
import RadarrAPI from '@server/api/servarr/radarr';
import type { SonarrSeries } from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieScanDetails,
  TmdbTvScanDetails,
} from '@server/api/themoviedb/interfaces';
import { MediaType } from '@server/constants/media';
import type { SeriesType } from '@server/constants/seriesType';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import type { AnimeDecidedBy } from '@server/lib/animeDecision';
import { decideAnime, requestSeriesType } from '@server/lib/animeDecision';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { In } from 'typeorm';

/*
 * Anime Check: which series in Sonarr sit in the wrong root folder or have
 * the wrong series type, and which movies in Radarr sit in the wrong root
 * folder or on the wrong quality profile, for what Seerr says they are.
 * Report only: nothing in Sonarr or Radarr is changed, moved or retyped.
 *
 * What a title should be is Seerr's own decision, the same as when it is
 * requested (lib/animeDecision): anime or not on its request (ticked by its
 * requester, or set by an override rule), then the title's own setting, set
 * on its page, then anime detection (utils/isAnime).
 */

export interface AnimeCheckProblem {
  sonarrId: number;
  title: string;
  tmdbId: number;
  path: string;
  seriesType: SonarrSeries['seriesType'];
  /** What Seerr says it is. */
  anime: boolean;
  decidedBy: AnimeDecidedBy;
  /** Typed anime when it is not, or the other way round. */
  wrongType: boolean;
  /** In the anime folder when it is not anime, or the other way round. */
  wrongFolder: boolean;
  /** Where it belongs, when the folder is wrong. */
  expectedFolder: string | null;
}

export interface AnimeCheckServer {
  id: number;
  name: string;
  is4k: boolean;
  animeFolder: string | null;
  /** Folders are only checked once an anime folder of its own is set. */
  foldersChecked: boolean;
  seriesChecked: number;
  /** Series TMDB has no match for, so nothing can be said about them. */
  unmatched: number;
  problems: AnimeCheckProblem[];
  error?: string;
}

export interface AnimeCheckMovieProblem {
  radarrId: number;
  title: string;
  tmdbId: number;
  path: string;
  /** What Seerr says it is. */
  anime: boolean;
  decidedBy: AnimeDecidedBy;
  /** In the anime folder when it is not anime, or the other way round. */
  wrongFolder: boolean;
  /** Where it belongs, when the folder is wrong. */
  expectedFolder: string | null;
  /** On the anime profile when it is not anime, or anime and not on it. */
  wrongProfile: boolean;
  /** The profile it belongs on, when that is wrong. */
  expectedProfile: string | null;
}

export interface AnimeCheckMovieServer {
  id: number;
  name: string;
  is4k: boolean;
  animeFolder: string | null;
  /** Folders are only checked once an anime folder of its own is set. */
  foldersChecked: boolean;
  /** Profiles likewise, once an anime profile of its own is set. */
  profilesChecked: boolean;
  moviesChecked: number;
  /** Movies TMDB has no match for, so nothing can be said about them. */
  unmatched: number;
  problems: AnimeCheckMovieProblem[];
  error?: string;
}

export interface AnimeCheckReport {
  finishedAt: string | null;
  running: boolean;
  /** Sonarr servers. */
  servers: AnimeCheckServer[];
  /** Radarr servers; missing from reports kept before movies were checked. */
  movieServers?: AnimeCheckMovieServer[];
}

const REPORT_PATH = process.env.CONFIG_DIRECTORY
  ? `${process.env.CONFIG_DIRECTORY}/anime-check.json`
  : path.join(__dirname, '../../config/anime-check.json');

/** TMDB lookups at once. */
const CONCURRENCY = 4;

const folderOf = (value: string) =>
  value.replace(/\\/g, '/').replace(/\/+$/, '');

/** Whether a series' path is in a root folder. */
export const inFolder = (seriesPath: string, root: string) => {
  const series = folderOf(seriesPath);
  const folder = folderOf(root);
  return series === folder || series.startsWith(`${folder}/`);
};

type Folders = Pick<SonarrSettings, 'activeDirectory' | 'activeAnimeDirectory'>;
type Profiles = Pick<
  RadarrSettings | SonarrSettings,
  'activeProfileId' | 'activeAnimeProfileId'
>;

/** Whether a server keeps anime in a folder of its own. */
export const hasAnimeFolder = (server: Folders) =>
  !!server.activeAnimeDirectory &&
  folderOf(server.activeAnimeDirectory) !== folderOf(server.activeDirectory);

/** Whether a server adds anime with a quality profile of its own. */
export const hasAnimeProfile = (server: Profiles) =>
  !!server.activeAnimeProfileId &&
  server.activeAnimeProfileId !== server.activeProfileId;

/**
 * Whether a title is in the wrong root folder for what it is, and the one
 * it belongs in. Only once the server keeps anime in a folder of its own.
 */
const folderVerdict = (path: string, anime: boolean, server: Folders) => {
  const wrongFolder =
    hasAnimeFolder(server) &&
    anime !== inFolder(path, server.activeAnimeDirectory as string);
  return {
    wrongFolder,
    expectedFolder: wrongFolder
      ? anime
        ? (server.activeAnimeDirectory as string)
        : server.activeDirectory
      : null,
  };
};

/**
 * Whether a title is on the wrong quality profile for what it is: anime on
 * the anime profile, and the rest on any other.
 */
export const onWrongProfile = (
  qualityProfileId: number,
  anime: boolean,
  server: Profiles
) =>
  hasAnimeProfile(server) &&
  anime !== (qualityProfileId === server.activeAnimeProfileId);

/** What is wrong with one series, if anything. */
export const judgeSeries = (
  series: Pick<SonarrSeries, 'path' | 'seriesType'>,
  anime: boolean,
  server: Folders
) => {
  const wrongType = anime
    ? series.seriesType !== 'anime'
    : series.seriesType === 'anime';
  return { wrongType, ...folderVerdict(series.path, anime, server) };
};

/** What is wrong with one movie, if anything. */
export const judgeMovie = (
  movie: Pick<RadarrMovie, 'path' | 'qualityProfileId'>,
  anime: boolean,
  server: Pick<
    RadarrSettings,
    | 'activeDirectory'
    | 'activeAnimeDirectory'
    | 'activeProfileId'
    | 'activeProfileName'
    | 'activeAnimeProfileId'
    | 'activeAnimeProfileName'
  >
) => {
  const wrongProfile = onWrongProfile(movie.qualityProfileId, anime, server);
  return {
    ...folderVerdict(movie.path, anime, server),
    wrongProfile,
    expectedProfile: wrongProfile
      ? anime
        ? (server.activeAnimeProfileName ?? String(server.activeAnimeProfileId))
        : (server.activeProfileName ?? String(server.activeProfileId))
      : null,
  };
};

/**
 * What Seerr was told about each title: its own anime setting, and the
 * series type chosen on its newest request that has one.
 */
const choices = async (
  tmdbIds: number[],
  is4k: boolean,
  mediaType: MediaType
) => {
  const chosen = new Map<
    number,
    { animeSetting: boolean | null; seriesType: SeriesType | null }
  >();
  if (!tmdbIds.length) {
    return chosen;
  }
  const media = await getRepository(Media).find({
    where: { tmdbId: In(tmdbIds), mediaType },
    relations: { requests: true },
  });
  for (const item of media) {
    const seriesType = requestSeriesType(item.requests ?? [], is4k);
    const animeSetting = item.animeSetting ?? null;
    if (seriesType || animeSetting !== null) {
      chosen.set(item.tmdbId, { animeSetting, seriesType });
    }
  }
  return chosen;
};

class AnimeCheck {
  private running = false;
  private cancelled = false;
  private report: AnimeCheckReport | null = null;

  public status() {
    return { running: this.running };
  }

  public cancel() {
    this.cancelled = true;
  }

  /** The last report, from memory or from the file it was kept in. */
  public async lastReport(): Promise<AnimeCheckReport> {
    if (!this.report) {
      try {
        this.report = JSON.parse(await fs.readFile(REPORT_PATH, 'utf-8'));
      } catch {
        this.report = { finishedAt: null, running: false, servers: [] };
      }
    }
    return { ...(this.report as AnimeCheckReport), running: this.running };
  }

  private async checkServer(
    server: SonarrSettings,
    tmdb: TheMovieDb
  ): Promise<AnimeCheckServer> {
    const result: AnimeCheckServer = {
      id: server.id,
      name: server.name,
      is4k: server.is4k,
      animeFolder: server.activeAnimeDirectory ?? null,
      foldersChecked: hasAnimeFolder(server),
      seriesChecked: 0,
      unmatched: 0,
      problems: [],
    };

    const sonarr = new SonarrAPI({
      apiKey: server.apiKey,
      url: SonarrAPI.buildUrl(server, '/api/v3'),
    });
    const allSeries = await sonarr.getSeries();

    // Sonarr knows most series' TMDB ids; the rest are found by TVDB id.
    const found: { series: SonarrSeries; show: TmdbTvScanDetails }[] = [];
    const queue = [...allSeries];
    const worker = async () => {
      while (queue.length && !this.cancelled) {
        const series = queue.shift() as SonarrSeries;
        try {
          const show = series.tmdbId
            ? await tmdb.getTvShowForScan({ tvId: series.tmdbId })
            : await tmdb.getShowByTvdbIdForScan({ tvdbId: series.tvdbId });
          found.push({ series, show });
        } catch {
          result.unmatched += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const chosen = await choices(
      found.map((f) => f.show.id),
      server.is4k,
      MediaType.TV
    );
    for (const { series, show } of found) {
      const choice = chosen.get(show.id);
      const { anime, decidedBy } = decideAnime(
        show,
        choice?.seriesType,
        choice?.animeSetting
      );
      const verdict = judgeSeries(series, anime, server);
      result.seriesChecked += 1;
      if (verdict.wrongType || verdict.wrongFolder) {
        result.problems.push({
          sonarrId: series.id ?? 0,
          title: series.title,
          tmdbId: show.id,
          path: series.path,
          seriesType: series.seriesType,
          anime,
          decidedBy,
          ...verdict,
        });
      }
    }
    result.problems.sort((a, b) => a.title.localeCompare(b.title));
    return result;
  }

  private async checkMovieServer(
    server: RadarrSettings,
    tmdb: TheMovieDb
  ): Promise<AnimeCheckMovieServer> {
    const result: AnimeCheckMovieServer = {
      id: server.id,
      name: server.name,
      is4k: server.is4k,
      animeFolder: server.activeAnimeDirectory ?? null,
      foldersChecked: hasAnimeFolder(server),
      profilesChecked: hasAnimeProfile(server),
      moviesChecked: 0,
      unmatched: 0,
      problems: [],
    };
    // With nothing of its own for anime, there is nothing to get wrong.
    if (!result.foldersChecked && !result.profilesChecked) {
      return result;
    }

    const radarr = new RadarrAPI({
      apiKey: server.apiKey,
      url: RadarrAPI.buildUrl(server, '/api/v3'),
    });
    const allMovies = await radarr.getMovies();

    const found: { movie: RadarrMovie; details: TmdbMovieScanDetails }[] = [];
    const queue = [...allMovies];
    const worker = async () => {
      while (queue.length && !this.cancelled) {
        const movie = queue.shift() as RadarrMovie;
        try {
          if (!movie.tmdbId) {
            throw new Error('No TMDB id');
          }
          found.push({
            movie,
            details: await tmdb.getMovieForScan({ movieId: movie.tmdbId }),
          });
        } catch {
          result.unmatched += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const chosen = await choices(
      found.map((f) => f.details.id),
      server.is4k,
      MediaType.MOVIE
    );
    for (const { movie, details } of found) {
      const choice = chosen.get(details.id);
      const { anime, decidedBy } = decideAnime(
        details,
        choice?.seriesType === 'anime' || choice?.seriesType === 'standard'
          ? choice.seriesType
          : null,
        choice?.animeSetting
      );
      const verdict = judgeMovie(movie, anime, server);
      result.moviesChecked += 1;
      if (verdict.wrongFolder || verdict.wrongProfile) {
        result.problems.push({
          radarrId: movie.id,
          title: movie.title,
          tmdbId: details.id,
          path: movie.path,
          anime,
          decidedBy,
          ...verdict,
        });
      }
    }
    result.problems.sort((a, b) => a.title.localeCompare(b.title));
    return result;
  }

  public async run(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.cancelled = false;
    try {
      const tmdb = new TheMovieDb();
      const servers: AnimeCheckServer[] = [];
      for (const server of getSettings().sonarr) {
        if (this.cancelled) {
          break;
        }
        try {
          servers.push(await this.checkServer(server, tmdb));
        } catch (e) {
          servers.push({
            id: server.id,
            name: server.name,
            is4k: server.is4k,
            animeFolder: server.activeAnimeDirectory ?? null,
            foldersChecked: false,
            seriesChecked: 0,
            unmatched: 0,
            problems: [],
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      const movieServers: AnimeCheckMovieServer[] = [];
      for (const server of getSettings().radarr) {
        if (this.cancelled) {
          break;
        }
        try {
          movieServers.push(await this.checkMovieServer(server, tmdb));
        } catch (e) {
          movieServers.push({
            id: server.id,
            name: server.name,
            is4k: server.is4k,
            animeFolder: server.activeAnimeDirectory ?? null,
            foldersChecked: false,
            profilesChecked: false,
            moviesChecked: 0,
            unmatched: 0,
            problems: [],
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      if (this.cancelled) {
        logger.info('Anime Check cancelled', { label: 'Anime Check' });
        return;
      }

      this.report = {
        finishedAt: new Date().toISOString(),
        running: false,
        servers,
        movieServers,
      };
      await fs.writeFile(REPORT_PATH, JSON.stringify(this.report)).catch((e) =>
        logger.warn('Could not keep the Anime Check report', {
          label: 'Anime Check',
          errorMessage: e.message,
        })
      );
      for (const server of servers) {
        logger.info(
          server.error
            ? `Anime Check could not read ${server.name}`
            : `Anime Check: ${server.problems.length} of ${server.seriesChecked} series on ${server.name} disagree with Seerr`,
          {
            label: 'Anime Check',
            ...(server.error ? { errorMessage: server.error } : {}),
            wrongType: server.problems.filter((p) => p.wrongType).length,
            wrongFolder: server.problems.filter((p) => p.wrongFolder).length,
            unmatched: server.unmatched,
          }
        );
      }
      for (const server of movieServers) {
        logger.info(
          server.error
            ? `Anime Check could not read ${server.name}`
            : `Anime Check: ${server.problems.length} of ${server.moviesChecked} movies on ${server.name} disagree with Seerr`,
          {
            label: 'Anime Check',
            ...(server.error ? { errorMessage: server.error } : {}),
            wrongFolder: server.problems.filter((p) => p.wrongFolder).length,
            wrongProfile: server.problems.filter((p) => p.wrongProfile).length,
            unmatched: server.unmatched,
          }
        );
      }
    } finally {
      this.running = false;
    }
  }
}

const animeCheck = new AnimeCheck();

export default animeCheck;
