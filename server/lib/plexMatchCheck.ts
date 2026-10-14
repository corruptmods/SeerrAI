import type { JellyfinUserItem } from '@server/api/jellyfin';
import type { PlexLibraryItem } from '@server/api/plexapi';
import PlexAPI from '@server/api/plexapi';
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
import { promises as fs } from 'node:fs';
import path from 'node:path';

/*
 * Match Check: which folders each connected media server (Plex, Jellyfin,
 * Emby) has matched to a different title than Sonarr or Radarr has in
 * them, or not matched at all. One report covers every server; each
 * problem says which server it is on.
 *
 * The media server matches by folder and file names, Sonarr and Radarr by
 * their own ids, and when the two disagree nothing says so: "Carrie" (2026)
 * matched to "The Carrie Diaries" made the wrong title available in Seerr,
 * left the right one without check marks, and showed the other show's
 * subtitles. Each item's folder is looked up in Sonarr or Radarr by its
 * name, and their ids compared. Report only: nothing is changed; the fix
 * is "Fix Match" in Plex, or "Identify" in Jellyfin and Emby.
 */

export type MediaServerName = 'Plex' | 'Jellyfin' | 'Emby';

export interface PlexMatchProblem {
  kind: 'movie' | 'series';
  /** The folder both sides point at. */
  folder: string;
  /** What Sonarr or Radarr has in that folder. */
  expected: {
    title: string;
    year?: number;
    tmdbId?: number;
    tvdbId?: number;
    imdbId?: string;
    server: string;
  };
  /** The media server it was checked on. */
  mediaServer: MediaServerName;
  /** What the media server matched it to, and its id for the item. */
  matched: {
    title: string;
    year?: number;
    key: string;
    tmdbId?: number;
    tvdbId?: number;
    imdbId?: string;
  };
  /**
   * - other: matched to another title (whatever its name: two films can
   *   share a name and a year).
   * - differentId: the same title by another id (IMDb), but the media
   *   server and Sonarr or Radarr use different TMDB or TVDB entries for
   *   it, so Seerr marks the server's entry available and not the one that
   *   was requested.
   * - unmatched: not matched to anything.
   */
  reason: 'other' | 'differentId' | 'unmatched';
}

export interface PlexMatchReport {
  finishedAt: string | null;
  running: boolean;
  /** Items whose folder Sonarr or Radarr has. */
  checked: number;
  /** Items that could not be compared: no folder, or no shared id. */
  notChecked: number;
  problems: PlexMatchProblem[];
  error?: string;
}

export const REPORT_PATH = process.env.CONFIG_DIRECTORY
  ? `${process.env.CONFIG_DIRECTORY}/plex-match-check.json`
  : path.join(__dirname, '../../config/plex-match-check.json');

/** Items read from the media server at a time. */
const PAGE_SIZE = 200;

/** The last part of a path, whichever way its slashes lean. */
export const folderName = (full: string): string =>
  full
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() ?? '';

/** The folder a movie's file sits in. */
const parentFolder = (file: string): string => {
  const parts = file.split(/[\\/]/);
  return parts.length > 1 ? (parts[parts.length - 2] ?? '') : '';
};

/** Folders are looked up whatever their case. */
const key = (folder: string) => folder.toLowerCase();

interface Ids {
  tmdbId?: number;
  tvdbId?: number;
  imdbId?: string;
}

/** The ids Plex gives an item, by its new agents or the legacy ones. */
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

/** The ids Jellyfin or Emby gives an item. */
export const jellyfinIds = (item: JellyfinUserItem): Ids => {
  const ids: Ids = {};
  const providers = (item.ProviderIds ?? {}) as Record<string, string>;
  // Keys differ in case between servers and versions: "Tmdb", "TMDB".
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
 * Whether the server's ids say the same title as Sonarr's or Radarr's: by the
 * id each side names first (TVDB for series, TMDB for movies), then the
 * others. Undefined when they share no id to compare.
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

interface Expected extends Ids {
  title: string;
  year?: number;
  server: string;
}

/** One item on the media server, as the check needs it. */
export interface MatchItem {
  title: string;
  year?: number;
  /** The server's id for it. */
  key: string;
  /** The folders it is in: a series' own, a movie's file's. */
  folders: string[];
  ids: Ids;
}

/** A Plex item, for the check. */
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
});

/** A Jellyfin or Emby item, for the check. */
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
  };
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
          expected: candidates[0],
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
          expected: sameFilm ?? candidates[0],
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

  public status() {
    return { running: this.running };
  }

  public cancel() {
    this.cancelled = true;
  }

  /** The last report, from memory or from the file it was kept in. */
  public async lastReport(): Promise<PlexMatchReport> {
    if (!this.report) {
      try {
        const kept = JSON.parse(
          await fs.readFile(REPORT_PATH, 'utf-8')
        ) as PlexMatchReport;
        // Reports kept before Jellyfin and Emby were checked name Plex's
        // side "plex", with its id as "ratingKey".
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
   * The problems the last report found for one title: one per server at
   * most, as each server matches it on its own. `key` is any server's id
   * for the title; `keys` are ids known to be a given server's (Emby's
   * ids and Plex's can look alike).
   */
  public async problemFor(
    kind: 'movie' | 'series',
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
        // The title Sonarr or Radarr has, which the server matched wrongly...
        ((ids.tmdbId && p.expected.tmdbId === ids.tmdbId) ||
          (ids.tvdbId && p.expected.tvdbId === ids.tvdbId) ||
          // ...or the title it matched it to, wrongly shown as available.
          (ids.key && p.matched.key === ids.key) ||
          ids.keys?.some(
            ({ mediaServer, key }) =>
              p.matched.key === key && (p.mediaServer ?? 'Plex') === mediaServer
          ))
    );
  }

  /**
   * Forgets what the last report found on a server Seerr is no longer
   * connected to; the rest of the report stays.
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
    try {
      const servers = connectedServers();
      if (!servers.length) {
        throw new Error('No media server is set up.');
      }
      const { series, movies } = await this.expectedFolders();
      // Every connected server, each on its own: one that cannot be read
      // leaves the others' findings, and the report says which it was.
      const failed: string[] = [];
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
          failed.push(
            servers.length > 1 ? `${serverName(server)}: ${message}` : message
          );
        }
      }
      report.problems.sort((a, b) =>
        a.expected.title.localeCompare(b.expected.title)
      );
      if (failed.length) {
        report.error = failed.join('; ');
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

      // A cancelled run only got part of the way through the libraries, so
      // its counts and problems would read as a whole check that found less.
      // The last full report stays instead.
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
      }
    }
  }
}

const plexMatchCheck = new PlexMatchCheck();
export default plexMatchCheck;
