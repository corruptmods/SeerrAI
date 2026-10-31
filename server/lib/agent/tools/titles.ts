import { musicBrainz } from '@server/api/musicbrainz';
import type { ProwlarrRelease } from '@server/api/prowlarr';
import TheMovieDb from '@server/api/themoviedb';
import {
  MediaStatus,
  MediaType,
  VIDEO_MEDIA_TYPES,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import BackfillCandidate from '@server/entity/BackfillCandidate';
import BackfillJob from '@server/entity/BackfillJob';
import BackfillSeries from '@server/entity/BackfillSeries';
import Media from '@server/entity/Media';
import { sceneDiffers } from '@server/lib/agent/numbering';
import { episodeLabel } from '@server/lib/agent/rules';
import type {
  AgentState,
  AgentTool,
  LibraryAlbums,
  TitleRef,
} from '@server/lib/agent/tools/base';
import {
  mainServers,
  originalOf,
  readTitleRef,
  titleMatches,
  titleRef,
} from '@server/lib/agent/tools/base';
import backfill from '@server/lib/backfill/engine';
import { musicReady } from '@server/lib/music/access';
import { albumStatuses } from '@server/lib/music/library';
import { rankAlbums } from '@server/lib/music/searchRank';
import { getSettings } from '@server/lib/settings';
import type { MusicAlbumResult } from '@server/models/Music';
import { mapAlbumResult } from '@server/models/Music';
import { In, MoreThan } from 'typeorm';
import { z } from 'zod';

/*
 * Finding a title, and what it has and lacks: find_title and
 * title_status.
 */

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
export const musicOn = () => backfill.readiness().music;

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

export const findTitle: AgentTool = {
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
export const backfillOf = async (title: TitleRef) => {
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
export const failedReleases = async (
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
export const sameRelease = (
  pack: Pick<BackfillCandidate, 'guid' | 'infoHash' | 'title'>,
  release: ProwlarrRelease
) =>
  pack.guid === release.guid ||
  (!!release.infoHash && pack.infoHash === release.infoHash.toLowerCase()) ||
  pack.title.toLowerCase() === release.title.toLowerCase();

export const titleStatus: AgentTool = {
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

/** A library title's name, as Sonarr, Radarr or Lidarr has it. */
export const nameOf = async (title: TitleRef): Promise<string> =>
  title.kind === 'album'
    ? albumName(title)
    : title.kind === 'movie'
      ? (await backfill.radarrFor(title.serverId).getMovieDetail(title.arrId))
          .title
      : (await backfill.sonarrFor(title.serverId).getSeriesDetail(title.arrId))
          .title;
