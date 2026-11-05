import type { JellyfinUserItem } from '@server/api/jellyfin';
import type { PlexLibraryItem } from '@server/api/plexapi';
import PlexAPI from '@server/api/plexapi';
import type { RadarrMovie } from '@server/api/servarr/radarr';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import type { JellyfinFamilyKind } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import {
  connectedServers,
  jellyfinClient,
  jellyfinFamily,
  serverName,
} from '@server/lib/mediaServers';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { MatchKind } from '@server/utils/plexMatch';
import { runtimeMinutes } from '@server/utils/plexMatch';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/*
 * Match Check: folders each connected media server (Plex, Jellyfin, Emby) has
 * matched to a different title than Sonarr or Radarr has there, or not matched
 * at all. One report covers every server; each problem names its server.
 *
 * The server matches by folder and file names, the *arrs by their own ids,
 * and nothing flags a disagreement: "Wrenna" (2026) matched to "The Wrenna
 * Diaries" made the wrong title available in Seerr, left the right one
 * unchecked, and showed the other show's subtitles. Each item's folder is
 * looked up in Sonarr or Radarr by name and the ids compared. Report only:
 * nothing is changed; the fix is "Fix Match" in Plex or "Identify" in
 * Jellyfin and Emby.
 */

export type MediaServerName = 'Plex' | 'Jellyfin' | 'Emby';

export interface PlexMatchProblem {
  /** Music comes only from the new-request check (lib/matchWatch). */
  kind: MatchKind;
  /** The folder both sides point at. */
  folder: string;
  /** What Sonarr, Radarr or Lidarr has in that folder. */
  expected: {
    title: string;
    year?: number;
    tmdbId?: number;
    tvdbId?: number;
    imdbId?: string;
    server: string;
    /** Radarr's film runtime, in minutes. */
    runtime?: number;
    /**
     * The file's own length in minutes (Radarr's reading, else the server's).
     */
    fileRuntime?: number;
    /** The file name in the folder, per Radarr. */
    file?: string;
    /** Music: the album's MusicBrainz release group, and its artist. */
    mbid?: string;
    artist?: string;
    artistMbid?: string;
  };
  mediaServer: MediaServerName;
  /** What the server matched it to, and the server's item id. */
  matched: {
    title: string;
    year?: number;
    key: string;
    tmdbId?: number;
    tvdbId?: number;
    imdbId?: string;
    /** Server-reported runtime, in minutes. */
    duration?: number;
    /** Music: the server's MusicBrainz album id, and its artist. */
    mbid?: string;
    artist?: string;
  };
  /**
   * - other: matched to another title (whatever its name: two films can share
   *   a name and year).
   * - differentId: same title by another id (IMDb), but the server and the *arr
   *   use different TMDB or TVDB entries, so Seerr marks the server's entry
   *   available instead of the requested one.
   * - unmatched: not matched to anything.
   */
  reason: 'other' | 'differentId' | 'unmatched';
  /** Auto-fixed in Plex by Seerr AI: what it is matched to now. */
  fixed?: { title: string; year?: number };
}

export interface PlexMatchReport {
  finishedAt: string | null;
  running: boolean;
  /** Items whose folder Sonarr or Radarr has. */
  checked: number;
  /** Items that couldn't be compared: no folder, or no shared id. */
  notChecked: number;
  problems: PlexMatchProblem[];
  error?: string;
}

export const REPORT_PATH = process.env.CONFIG_DIRECTORY
  ? `${process.env.CONFIG_DIRECTORY}/plex-match-check.json`
  : path.join(__dirname, '../../config/plex-match-check.json');

/**
 * Identity of a problem regardless of who found it: server, the *arr's title,
 * and the matched title's ids (not the server's item id, which a rescan
 * changes).
 */
export const problemKey = (p: PlexMatchProblem): string => {
  const e = p.expected;
  const title =
    p.kind === 'music'
      ? `mb:${e.mbid ?? p.folder.toLowerCase()}`
      : p.kind === 'series'
        ? e.tvdbId
          ? `tvdb:${e.tvdbId}`
          : `tmdb:${e.tmdbId ?? ''}:${e.imdbId ?? ''}`
        : e.tmdbId
          ? `tmdb:${e.tmdbId}`
          : `imdb:${e.imdbId ?? ''}`;
  const m = p.matched;
  const ids = [m.tmdbId, m.tvdbId, m.imdbId, m.mbid]
    .map((id) => id ?? '')
    .join(',');
  const to =
    p.reason === 'unmatched'
      ? 'unmatched'
      : ids.replace(/,/g, '')
        ? ids
        : `title:${m.title.toLowerCase()}`;
  return [p.mediaServer ?? 'Plex', p.kind, title, to].join('|');
};

/** Items fetched from the media server per page. */
const PAGE_SIZE = 200;

/** The last path segment, with either slash style. */
export const folderName = (full: string): string =>
  full
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() ?? '';

/** The folder a movie file is in. */
const parentFolder = (file: string): string => {
  const parts = file.split(/[\\/]/);
  return parts.length > 1 ? (parts[parts.length - 2] ?? '') : '';
};

/** Case-insensitive folder key. */
const key = (folder: string) => folder.toLowerCase();

interface Ids {
  tmdbId?: number;
  tvdbId?: number;
  imdbId?: string;
}

/** An item's ids from Plex's new or legacy agents. */
export const plexIds = (item: PlexLibraryItem): Ids => {
  const ids: Ids = {};
  const refs = [...(item.Guid ?? []).map((g) => g.id), item.guid ?? ''];
  for (const ref of refs) {
    const tmdb = ref.match(/(?:tmdb|themoviedb):\/\/(\d+)/);
    const tvdb = ref.match(/(?:tvdb|thetvdb):\/\/(\d+)/);
    const imdb = ref.match(/imdb:\/\/(tt\d+)/);
    if (tmdb && !ids.tmdbId) ids.tmdbId = Number(tmdb[1]);
    if (tvdb && !ids.tvdbId) ids.tvdbId = Number(tvdb[1]);
    if (imdb && !ids.imdbId) ids.imdbId = imdb[1];
  }
  return ids;
};

/** An item's ids from Jellyfin or Emby. */
export const jellyfinIds = (item: JellyfinUserItem): Ids => {
  const ids: Ids = {};
  const providers = (item.ProviderIds ?? {}) as Record<string, string>;
  // Key case varies by server and version: "Tmdb", "TMDB".
  const read = (name: string) =>
    Object.entries(providers).find(
      ([key, value]) => key.toLowerCase() === name && !!value
    )?.[1];
  const tmdb = Number(read('tmdb') ?? read('themoviedb'));
  const tvdb = Number(read('tvdb'));
  const imdb = read('imdb');
  if (Number.isInteger(tmdb) && tmdb > 0) ids.tmdbId = tmdb;
  if (Number.isInteger(tvdb) && tvdb > 0) ids.tvdbId = tvdb;
  if (imdb && /^tt\d+$/.test(imdb)) ids.imdbId = imdb;
  return ids;
};

/**
 * Whether the server's ids name the *arr's title: by each side's primary id
 * (TVDB for series, TMDB for movies), then the others. Undefined when no id
 * is shared.
 */
export const sameTitle = (
  kind: 'movie' | 'series',
  expected: Ids,
  plex: Ids
): boolean | undefined => {
  const order: (keyof Ids)[] =
    kind === 'series'
      ? ['tvdbId', 'tmdbId', 'imdbId']
      : ['tmdbId', 'imdbId', 'tvdbId'];
  for (const key of order) {
    if (expected[key] && plex[key]) return expected[key] === plex[key];
  }
  return undefined;
};

/** Whether any id both sides have agrees. */
const anyIdAgrees = (expected: Ids, plex: Ids): boolean =>
  (['tmdbId', 'tvdbId', 'imdbId'] as const).some(
    (key) => expected[key] && plex[key] && expected[key] === plex[key]
  );

export interface Expected extends Ids {
  title: string;
  year?: number;
  server: string;
  runtime?: number;
  fileRuntime?: number;
  file?: string;
}

/** One media server item, as the check needs it. */
export interface MatchItem {
  title: string;
  year?: number;
  /** The server's id for it. */
  key: string;
  /** Its folders: a series' own, or a movie file's. */
  folders: string[];
  ids: Ids;
  /** Runtime in minutes, if the server gives one. */
  duration?: number;
}

const msToMinutes = (ms?: number): number | undefined =>
  ms && ms > 0 ? Math.round(ms / 60_000) : undefined;

export const plexMatchItem = (
  kind: 'movie' | 'series',
  item: PlexLibraryItem
): MatchItem => ({
  title: item.title,
  year: item.year,
  key: item.ratingKey,
  folders:
    kind === 'series'
      ? (item.Location ?? []).map((l) => folderName(l.path))
      : (item.Media ?? []).flatMap((m) =>
          (m.Part ?? []).flatMap((p) => (p.file ? [parentFolder(p.file)] : []))
        ),
  ids: plexIds(item),
  duration:
    kind === 'movie' ? msToMinutes(item.Media?.[0]?.duration) : undefined,
});

export const jellyfinMatchItem = (
  kind: 'movie' | 'series',
  item: JellyfinUserItem
): MatchItem => ({
  title: item.Name,
  year: item.ProductionYear,
  key: item.Id,
  folders: item.Path
    ? [kind === 'series' ? folderName(item.Path) : parentFolder(item.Path)]
    : [],
  ids: jellyfinIds(item),
  // Ticks are 100 ns.
  duration:
    kind === 'movie' && item.RunTimeTicks
      ? msToMinutes(item.RunTimeTicks / 10_000)
      : undefined,
});

/**
 * Radarr facts that show whose mistake a wrong match is: the film's runtime,
 * the file's, and the file name.
 */
export const radarrFileFacts = (
  movie: Pick<RadarrMovie, 'runtime' | 'movieFile'>
): Pick<Expected, 'runtime' | 'fileRuntime' | 'file'> => ({
  runtime: movie.runtime || undefined,
  fileRuntime: runtimeMinutes(movie.movieFile?.mediaInfo?.runTime),
  file: movie.movieFile?.relativePath || undefined,
});

/** Compares one Plex item with what Sonarr or Radarr has in its folders. */
export const compareItem = (
  kind: 'movie' | 'series',
  item: PlexLibraryItem,
  byFolder: Map<string, Expected[]>
): { checked: boolean; problem?: PlexMatchProblem } =>
  compareMatch(kind, plexMatchItem(kind, item), byFolder, 'Plex');

/** Compares one server item with what Sonarr or Radarr has in its folders. */
export const compareMatch = (
  kind: 'movie' | 'series',
  item: MatchItem,
  byFolder: Map<string, Expected[]>,
  mediaServer: MediaServerName
): { checked: boolean; problem?: PlexMatchProblem } => {
  const { folders, ids } = item;
  const matched = {
    title: item.title,
    year: item.year,
    key: item.key,
    ...ids,
    ...(item.duration ? { duration: item.duration } : {}),
  };
  // The server measured the same file: use its length when Radarr has none.
  const withFile = (e: Expected): Expected =>
    kind === 'movie' && !e.fileRuntime && item.duration
      ? { ...e, fileRuntime: item.duration }
      : e;
  let checked = false;
  for (const folder of new Set(folders.filter(Boolean))) {
    const candidates = byFolder.get(key(folder));
    if (!candidates?.length) continue;
    // Not matched at all: "local://" or no ids.
    if (!ids.tmdbId && !ids.tvdbId && !ids.imdbId) {
      return {
        checked: true,
        problem: {
          kind,
          folder,
          expected: withFile(candidates[0]),
          mediaServer,
          matched,
          reason: 'unmatched',
        },
      };
    }
    const verdicts = candidates.map((c) => sameTitle(kind, c, ids));
    if (verdicts.includes(true)) return { checked: true };
    if (verdicts.every((v) => v === false)) {
      const sameFilm = candidates.find((c) => anyIdAgrees(c, ids));
      return {
        checked: true,
        problem: {
          kind,
          folder,
          expected: withFile(sameFilm ?? candidates[0]),
          mediaServer,
          matched,
          reason: sameFilm ? 'differentId' : 'other',
        },
      };
    }
    checked = checked || verdicts.some((v) => v !== undefined);
  }
  return { checked };
};

class PlexMatchCheck {
  private running = false;
  private cancelled = false;
  private report: PlexMatchReport | null = null;
  private onFinished?: (
    report: PlexMatchReport,
    unread: MediaServerName[]
  ) => Promise<void> | void;

  /**
   * Callback after a full run is saved: the new-request check resolves what it
   * found that this run found right. `unread` lists servers not read this run.
   */
  public whenFinished(
    run: (
      report: PlexMatchReport,
      unread: MediaServerName[]
    ) => Promise<void> | void
  ) {
    this.onFinished = run;
  }

  public status() {
    return { running: this.running };
  }

  public cancel() {
    this.cancelled = true;
  }

  /** Removes fixed problems from the last report and saves it. */
  public async forget(keys: string[]): Promise<void> {
    const report = await this.lastReport();
    const gone = new Set(keys);
    const problems = report.problems.filter((p) => !gone.has(problemKey(p)));
    if (problems.length === report.problems.length) return;
    this.report = { ...(this.report as PlexMatchReport), problems };
    await fs
      .writeFile(REPORT_PATH, JSON.stringify(this.report))
      .catch((e: Error) =>
        logger.warn('Could not keep the Match Check report', {
          label: 'Match Check',
          errorMessage: e.message,
        })
      );
  }

  /** The last report, from memory or its saved file. */
  public async lastReport(): Promise<PlexMatchReport> {
    if (!this.report) {
      try {
        const kept = JSON.parse(
          await fs.readFile(REPORT_PATH, 'utf-8')
        ) as PlexMatchReport;
        // Reports saved before Jellyfin and Emby support call Plex's side
        // "plex", with its id as "ratingKey".
        kept.problems = (kept.problems ?? []).map((p) => {
          const old = p as PlexMatchProblem & {
            plex?: Omit<PlexMatchProblem['matched'], 'key'> & {
              ratingKey: string;
            };
          };
          if (old.matched || !old.plex) return p;
          const { ratingKey, ...rest } = old.plex;
          return {
            ...p,
            mediaServer: 'Plex',
            matched: { ...rest, key: ratingKey },
          };
        });
        this.report = kept;
      } catch {
        this.report = {
          finishedAt: null,
          running: false,
          checked: 0,
          notChecked: 0,
          problems: [],
        };
      }
    }
    return { ...(this.report as PlexMatchReport), running: this.running };
  }

  /**
   * The last report's problems for one title, at most one per server since
   * each matches independently. `keys` are the title's ids per server; `key`
   * alone is a Plex rating key, since Emby and Plex ids look alike and would
   * find another title's problem on the other server.
   */
  public async problemFor(
    kind: MatchKind,
    ids: {
      tmdbId?: number;
      tvdbId?: number;
      key?: string | null;
      keys?: { mediaServer: MediaServerName; key: string }[];
    }
  ): Promise<PlexMatchProblem[]> {
    const report = await this.lastReport();
    return report.problems.filter(
      (p) =>
        p.kind === kind &&
        // The *arr's title, which the server matched wrongly...
        ((ids.tmdbId && p.expected.tmdbId === ids.tmdbId) ||
          (ids.tvdbId && p.expected.tvdbId === ids.tvdbId) ||
          // ...or the title it was matched to, wrongly shown as available.
          (ids.key &&
            p.matched.key === ids.key &&
            (p.mediaServer ?? 'Plex') === 'Plex') ||
          ids.keys?.some(
            ({ mediaServer, key }) =>
              p.matched.key === key && (p.mediaServer ?? 'Plex') === mediaServer
          ))
    );
  }

  /**
   * Drops the last report's findings for a disconnected server; the rest stays.
   */
  public async dropServer(mediaServer: MediaServerName): Promise<void> {
    const report = await this.lastReport();
    const problems = report.problems.filter(
      (p) => (p.mediaServer ?? 'Plex') !== mediaServer
    );
    if (problems.length === report.problems.length) return;
    this.report = { ...(this.report as PlexMatchReport), problems };
    await fs.writeFile(REPORT_PATH, JSON.stringify(this.report)).catch((e) =>
      logger.warn('Could not keep the Match Check report', {
        label: 'Match Check',
        errorMessage: e.message,
      })
    );
  }

  private async expectedFolders(): Promise<{
    series: Map<string, Expected[]>;
    movies: Map<string, Expected[]>;
  }> {
    const settings = getSettings();
    const series = new Map<string, Expected[]>();
    const movies = new Map<string, Expected[]>();
    const add = (map: Map<string, Expected[]>, folder: string, e: Expected) =>
      map.set(folder, [...(map.get(folder) ?? []), e]);
    for (const server of settings.sonarr) {
      const api = new SonarrAPI({
        apiKey: server.apiKey,
        url: SonarrAPI.buildUrl(server, '/api/v3'),
      });
      for (const s of await api.getSeries()) {
        add(series, key(folderName(s.path)), {
          title: s.title,
          year: s.year,
          tvdbId: s.tvdbId || undefined,
          tmdbId: s.tmdbId || undefined,
          imdbId: s.imdbId || undefined,
          server: server.name,
        });
      }
    }
    for (const server of settings.radarr) {
      const api = new RadarrAPI({
        apiKey: server.apiKey,
        url: RadarrAPI.buildUrl(server, '/api/v3'),
      });
      for (const m of await api.getMovies()) {
        add(movies, key(folderName(m.path)), {
          title: m.title,
          year: m.year,
          tmdbId: m.tmdbId || undefined,
          imdbId: m.imdbId || undefined,
          server: server.name,
          ...radarrFileFacts(m),
        });
      }
    }
    return { series, movies };
  }

  private async checkPlex(
    report: PlexMatchReport,
    expected: {
      series: Map<string, Expected[]>;
      movies: Map<string, Expected[]>;
    }
  ): Promise<void> {
    const settings = getSettings();
    const admin = await getRepository(User).findOne({
      select: { id: true, plexToken: true },
      where: { id: 1 },
    });
    const plex = new PlexAPI({ plexToken: admin?.plexToken });
    for (const library of settings.plex.libraries) {
      if (!library.enabled || this.cancelled) continue;
      const kind = library.type === 'show' ? 'series' : 'movie';
      const byFolder = kind === 'series' ? expected.series : expected.movies;
      for (let offset = 0; !this.cancelled; offset += PAGE_SIZE) {
        const { items, totalSize } = await plex.getLibraryContents(library.id, {
          offset,
          size: PAGE_SIZE,
        });
        for (const item of items) {
          this.tally(report, compareItem(kind, item, byFolder));
        }
        if (!items.length || offset + PAGE_SIZE >= totalSize) break;
      }
    }
  }

  private async checkJellyfin(
    report: PlexMatchReport,
    server: JellyfinFamilyKind,
    expected: {
      series: Map<string, Expected[]>;
      movies: Map<string, Expected[]>;
    }
  ): Promise<void> {
    const mediaServer = serverName(server) as 'Jellyfin' | 'Emby';
    const settings = jellyfinFamily(server);
    if (!settings.apiKey) {
      throw new Error(`${mediaServer} has no API key set.`);
    }
    const api = await jellyfinClient(server);
    for (const library of settings.libraries) {
      if (!library.enabled || this.cancelled) continue;
      const kind = library.type === 'show' ? 'series' : 'movie';
      const byFolder = kind === 'series' ? expected.series : expected.movies;
      for (let start = 0; !this.cancelled; start += PAGE_SIZE) {
        const { Items, TotalRecordCount } = await api.getLibraryPage(
          library.id,
          kind === 'series' ? 'Series' : 'Movie',
          start,
          PAGE_SIZE
        );
        for (const item of Items) {
          this.tally(
            report,
            compareMatch(
              kind,
              jellyfinMatchItem(kind, item),
              byFolder,
              mediaServer
            )
          );
        }
        if (!Items.length || start + PAGE_SIZE >= TotalRecordCount) break;
      }
    }
  }

  private tally(
    report: PlexMatchReport,
    { checked, problem }: { checked: boolean; problem?: PlexMatchProblem }
  ): void {
    if (checked) report.checked += 1;
    else report.notChecked += 1;
    if (problem) report.problems.push(problem);
  }

  public async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.cancelled = false;
    const report: PlexMatchReport = {
      finishedAt: null,
      running: false,
      checked: 0,
      notChecked: 0,
      problems: [],
    };
    // Servers this run can't speak for: not read, or not reached.
    let unread: MediaServerName[] = connectedServers().map(
      (server) => serverName(server) as MediaServerName
    );
    try {
      const servers = connectedServers();
      if (!servers.length) {
        throw new Error('No media server is set up.');
      }
      const { series, movies } = await this.expectedFolders();
      // Each connected server separately: one unreadable server leaves the
      // others' findings, and the report names it.
      const failed: { server: MediaServerName; message: string }[] = [];
      for (const server of servers) {
        if (this.cancelled) break;
        try {
          if (server === 'plex') {
            await this.checkPlex(report, { series, movies });
          } else {
            await this.checkJellyfin(report, server, { series, movies });
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          failed.push({
            server: serverName(server) as MediaServerName,
            message:
              servers.length > 1
                ? `${serverName(server)}: ${message}`
                : message,
          });
        }
      }
      // A server removed mid-run already had its findings dropped (dropServer);
      // this report must not restore them.
      const stillConnected = connectedServers().map(serverName);
      report.problems = report.problems.filter((p) =>
        stillConnected.includes(p.mediaServer ?? 'Plex')
      );
      const stillFailed = failed.filter((f) =>
        stillConnected.includes(f.server)
      );
      unread = failed.map((f) => f.server);
      report.problems.sort((a, b) =>
        a.expected.title.localeCompare(b.expected.title)
      );
      if (stillFailed.length) {
        report.error = stillFailed.map((f) => f.message).join('; ');
        logger.warn('Match Check could not finish', {
          label: 'Match Check',
          errorMessage: report.error,
        });
      } else {
        logger.info(
          `Match Check: ${report.problems.length} folder(s) matched to another title or none, of ${report.checked} checked`,
          { label: 'Match Check', notChecked: report.notChecked }
        );
      }
    } catch (e) {
      report.error = e instanceof Error ? e.message : String(e);
      logger.warn('Match Check could not finish', {
        label: 'Match Check',
        errorMessage: report.error,
      });
    } finally {
      this.running = false;

      // A cancelled run covered only part of the libraries, so its counts and
      // problems would look like a full check that found less. Keep the last
      // full report instead.
      if (this.cancelled) {
        logger.info('Match Check cancelled; the last report is kept', {
          label: 'Match Check',
        });
      } else {
        report.finishedAt = new Date().toISOString();
        this.report = report;
        await fs.writeFile(REPORT_PATH, JSON.stringify(report)).catch((e) =>
          logger.warn('Could not keep the Match Check report', {
            label: 'Match Check',
            errorMessage: e.message,
          })
        );
        try {
          await this.onFinished?.(report, unread);
        } catch (e) {
          logger.warn('Could not compare the report with new requests', {
            label: 'Match Check',
            errorMessage: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }
  }
}

const plexMatchCheck = new PlexMatchCheck();
export default plexMatchCheck;
