import type { PlexLibraryItem } from '@server/api/plexapi';
import PlexAPI from '@server/api/plexapi';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/*
 * Plex Match Check: which folders Plex has matched to a different title
 * than Sonarr or Radarr has in them, or not matched at all.
 *
 * Plex matches by folder and file names, Sonarr and Radarr by their own
 * ids, and when the two disagree nothing says so: "Carrie" (2026) matched
 * to "The Carrie Diaries" made the wrong title available in Seerr, left
 * the right one without check marks, and showed the other show's
 * subtitles. Each Plex item's folder is looked up in Sonarr or Radarr by
 * its name, and their ids compared. Report only: nothing is changed; the
 * fix is "Fix Match" on the title in Plex.
 */

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
  /** What Plex matched it to. */
  plex: {
    title: string;
    year?: number;
    ratingKey: string;
    tmdbId?: number;
    tvdbId?: number;
    imdbId?: string;
  };
  /**
   * - other: matched to another title (whatever its name: two films can
   *   share a name and a year).
   * - differentId: the same title by another id (IMDb), but Plex and
   *   Sonarr or Radarr use different TMDB or TVDB entries for it, so Seerr
   *   marks Plex's entry available and not the one that was requested.
   * - unmatched: not matched to anything.
   */
  reason: 'other' | 'differentId' | 'unmatched';
}

export interface PlexMatchReport {
  finishedAt: string | null;
  running: boolean;
  /** Plex items whose folder Sonarr or Radarr has. */
  checked: number;
  /** Plex items that could not be compared: no folder, or no shared id. */
  notChecked: number;
  problems: PlexMatchProblem[];
  error?: string;
}

export const REPORT_PATH = process.env.CONFIG_DIRECTORY
  ? `${process.env.CONFIG_DIRECTORY}/plex-match-check.json`
  : path.join(__dirname, '../../config/plex-match-check.json');

/** Items read from Plex at a time. */
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

/**
 * Whether Plex's ids say the same title as Sonarr's or Radarr's: by the
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

/** Compares one Plex item with what Sonarr or Radarr has in its folders. */
export const compareItem = (
  kind: 'movie' | 'series',
  item: PlexLibraryItem,
  byFolder: Map<string, Expected[]>
): { checked: boolean; problem?: PlexMatchProblem } => {
  const folders =
    kind === 'series'
      ? (item.Location ?? []).map((l) => folderName(l.path))
      : (item.Media ?? []).flatMap((m) =>
          (m.Part ?? []).flatMap((p) => (p.file ? [parentFolder(p.file)] : []))
        );
  const ids = plexIds(item);
  const plex = {
    title: item.title,
    year: item.year,
    ratingKey: item.ratingKey,
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
          plex,
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
          plex,
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
        this.report = JSON.parse(await fs.readFile(REPORT_PATH, 'utf-8'));
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

  /** The problem for one title, if the last report found one. */
  public async problemFor(
    kind: 'movie' | 'series',
    ids: { tmdbId?: number; tvdbId?: number; ratingKey?: string | null }
  ): Promise<PlexMatchProblem | undefined> {
    const report = await this.lastReport();
    return report.problems.find(
      (p) =>
        p.kind === kind &&
        // The title Sonarr or Radarr has, which Plex matched wrongly...
        ((ids.tmdbId && p.expected.tmdbId === ids.tmdbId) ||
          (ids.tvdbId && p.expected.tvdbId === ids.tvdbId) ||
          // ...or the title Plex matched it to, wrongly shown as available.
          (ids.ratingKey && p.plex.ratingKey === ids.ratingKey))
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
      const settings = getSettings();
      if (settings.main.mediaServerType !== MediaServerType.PLEX) {
        throw new Error('Only Plex is checked.');
      }
      const admin = await getRepository(User).findOne({
        select: { id: true, plexToken: true },
        where: { id: 1 },
      });
      const plex = new PlexAPI({ plexToken: admin?.plexToken });
      const { series, movies } = await this.expectedFolders();

      for (const library of settings.plex.libraries) {
        if (!library.enabled || this.cancelled) continue;
        const kind = library.type === 'show' ? 'series' : 'movie';
        const byFolder = kind === 'series' ? series : movies;
        for (let offset = 0; !this.cancelled; offset += PAGE_SIZE) {
          const { items, totalSize } = await plex.getLibraryContents(
            library.id,
            { offset, size: PAGE_SIZE }
          );
          for (const item of items) {
            const { checked, problem } = compareItem(kind, item, byFolder);
            if (checked) report.checked += 1;
            else report.notChecked += 1;
            if (problem) report.problems.push(problem);
          }
          if (!items.length || offset + PAGE_SIZE >= totalSize) break;
        }
      }
      report.problems.sort((a, b) =>
        a.expected.title.localeCompare(b.expected.title)
      );
      logger.info(
        `Plex Match Check: ${report.problems.length} folder(s) matched to another title or none, of ${report.checked} checked`,
        { label: 'Plex Match Check', notChecked: report.notChecked }
      );
    } catch (e) {
      report.error = e instanceof Error ? e.message : String(e);
      logger.warn('Plex Match Check could not finish', {
        label: 'Plex Match Check',
        errorMessage: report.error,
      });
    } finally {
      report.finishedAt = new Date().toISOString();
      this.report = report;
      this.running = false;
      await fs.writeFile(REPORT_PATH, JSON.stringify(report)).catch((e) =>
        logger.warn('Could not keep the Plex Match Check report', {
          label: 'Plex Match Check',
          errorMessage: e.message,
        })
      );
    }
  }
}

const plexMatchCheck = new PlexMatchCheck();
export default plexMatchCheck;
