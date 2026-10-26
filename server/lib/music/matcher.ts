import { isMbid, musicBrainz } from '@server/api/musicbrainz';
import type { MbReleaseGroup } from '@server/api/musicbrainz/interfaces';
import type { LidarrAlbum, LidarrArtist } from '@server/api/servarr/lidarr';
import type { MediaServerKind } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import MusicMetadata from '@server/entity/MusicMetadata';
import { lidarrApi } from '@server/lib/music/access';
import type { LidarrSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { In } from 'typeorm';

/*
 * Which artist and album (MusicBrainz ids) an album on a media server is.
 *
 * Lidarr is asked first, since it costs nothing against MusicBrainz's limit
 * of a request a second: its artists with their folders, and their albums
 * with every release's id. Then MusicBrainz answers kept from before, and
 * last MusicBrainz itself, in the background and at most MB_CALL_CAP times
 * a run.
 *
 * Artist, in order: the server's MusicBrainz id for it; its folder against
 * Lidarr's; its name, when exactly one Lidarr artist has it.
 * Album: the server's release-group id (Jellyfin, Emby); a release id (or,
 * from Plex, an id that is either) turned into its album; then, within the
 * artist, the folder name, then the title and year. Only a single match
 * counts.
 */

/** Calls to MusicBrainz one run may make to place albums. */
export const MB_CALL_CAP = 200;

/** A name or title, compared without case, accents, "the" or punctuation. */
export const normalizeName = (value?: string | null): string =>
  (value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/^\s*the\s+/, '')
    .replace(/[^\p{L}\p{N}]/gu, '');

/** The last folder of a path, either kind of slash, as written. */
export const folderName = (path?: string | null): string | undefined => {
  const parts = (path ?? '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : undefined;
};

/** A path without its last part: the folder a file or folder is in. */
export const parentPath = (path?: string | null): string | undefined => {
  const parts = (path ?? '').split(/[\\/]/);
  while (parts.length && !parts[parts.length - 1]) parts.pop();
  parts.pop();
  const parent = parts.join('/');
  return parent || undefined;
};

/** Folders compared as Match Check does: the last one, in lower case. */
const folderKey = (path?: string | null): string | undefined =>
  folderName(path)?.toLowerCase();

const yearOf = (date?: string | null): number | undefined => {
  const year = Number((date ?? '').slice(0, 4));
  return Number.isFinite(year) && year > 0 ? year : undefined;
};

/** An artist as Lidarr has it. */
export interface IndexArtist {
  serverId: number;
  id: number;
  mbid: string;
  name: string;
  path?: string;
  monitored: boolean;
}

/** An album as Lidarr has it, with its files. */
export interface IndexAlbum {
  serverId: number;
  id: number;
  mbid: string;
  artistMbid: string;
  title: string;
  albumType?: string;
  secondaryTypes: string[];
  /** As MusicBrainz writes dates: just the day. */
  releaseDate?: string;
  monitored: boolean;
  trackCount: number;
  trackFileCount: number;
  releaseIds: string[];
}

const toIndexAlbum = (
  serverId: number,
  album: LidarrAlbum,
  artistMbid: string
): IndexAlbum => ({
  serverId,
  id: album.id,
  mbid: album.foreignAlbumId,
  artistMbid: album.artist?.foreignArtistId ?? artistMbid,
  title: album.title,
  albumType: album.albumType || undefined,
  secondaryTypes: album.secondaryTypes ?? [],
  releaseDate: album.releaseDate ? album.releaseDate.slice(0, 10) : undefined,
  monitored: !!album.monitored,
  // Lidarr counts an unmonitored album's tracks as only those with a file
  // (a song taken from it would make it whole): its total is the album's.
  trackCount: album.monitored
    ? (album.statistics?.trackCount ?? 0)
    : Math.max(
        album.statistics?.trackCount ?? 0,
        album.statistics?.totalTrackCount ?? 0
      ),
  trackFileCount: album.statistics?.trackFileCount ?? 0,
  releaseIds: (album.releases ?? [])
    .map((release) => release.foreignReleaseId)
    .filter(Boolean),
});

/**
 * What every Lidarr has: all artists, and albums either all at once (a full
 * scan) or artist by artist as matching needs them. `complete` is false
 * once any Lidarr failed to answer.
 */
export class LidarrIndex {
  public complete = true;
  private servers: LidarrSettings[];
  private full: boolean;
  private artists = new Map<string, IndexArtist[]>();
  private byFolder = new Map<string, IndexArtist[]>();
  private byName = new Map<string, IndexArtist[]>();
  private albums = new Map<string, IndexAlbum>();
  private byRelease = new Map<string, string>();
  private albumsByArtist = new Map<string, IndexAlbum[]>();
  /** Artists whose albums are loaded, by Lidarr and Lidarr's artist id. */
  private loaded = new Set<string>();

  constructor(servers: LidarrSettings[], { full }: { full: boolean }) {
    this.servers = servers;
    this.full = full;
  }

  public async load(): Promise<void> {
    for (const server of this.servers) {
      const api = lidarrApi(server);
      try {
        const artists = await api.getArtists();
        for (const artist of artists) this.addArtist(server.id, artist);
        if (this.full) {
          const byId = new Map(artists.map((a) => [a.id, a.foreignArtistId]));
          for (const album of await api.getAlbums()) {
            this.addAlbum(
              server.id,
              album,
              byId.get(album.artistId) ?? album.artist?.foreignArtistId ?? ''
            );
          }
          for (const artist of artists) {
            this.loaded.add(`${server.id}:${artist.id}`);
          }
        }
      } catch (e) {
        this.complete = false;
        logger.warn('Lidarr did not answer; its music is left as it was', {
          label: 'Music Scan',
          lidarr: server.name,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  private addArtist(serverId: number, artist: LidarrArtist) {
    if (!isMbid(artist.foreignArtistId)) return;
    const entry: IndexArtist = {
      serverId,
      id: artist.id,
      mbid: artist.foreignArtistId,
      name: artist.artistName,
      path: artist.path,
      monitored: !!artist.monitored,
    };
    const push = (map: Map<string, IndexArtist[]>, key?: string) => {
      if (!key) return;
      map.set(key, [...(map.get(key) ?? []), entry]);
    };
    push(this.artists, entry.mbid);
    push(this.byFolder, folderKey(entry.path));
    push(this.byName, normalizeName(entry.name) || undefined);
  }

  /** Takes in an album Lidarr has, such as one just added to it. */
  public addAlbum(serverId: number, album: LidarrAlbum, artistMbid: string) {
    if (!isMbid(album.foreignAlbumId)) return;
    const entry = toIndexAlbum(serverId, album, artistMbid);
    const known = this.albums.get(entry.mbid);
    // An album in two Lidarrs: the one with more of it counts. The same
    // Lidarr's newer answer replaces its older one.
    if (
      !known ||
      known.serverId === entry.serverId ||
      entry.trackFileCount > known.trackFileCount
    ) {
      this.albums.set(entry.mbid, entry);
    }
    for (const release of entry.releaseIds) {
      this.byRelease.set(release, entry.mbid);
    }
    const list = (this.albumsByArtist.get(entry.artistMbid) ?? []).filter(
      (a) => !(a.mbid === entry.mbid && a.serverId === entry.serverId)
    );
    list.push(entry);
    this.albumsByArtist.set(entry.artistMbid, list);
  }

  /** Lidarr's artist in this folder, when only one is. */
  public artistByFolder(path?: string): IndexArtist | undefined {
    const key = folderKey(path);
    const found = key ? this.byFolder.get(key) : undefined;
    return unique(found);
  }

  /** Lidarr's artist of this name, when only one has it. */
  public artistByName(name?: string): IndexArtist | undefined {
    const key = normalizeName(name);
    return key ? unique(this.byName.get(key)) : undefined;
  }

  /** The artist's name as Lidarr has it (MusicBrainz's own). */
  public artistName(mbid: string): string | undefined {
    return this.artists.get(mbid)?.[0]?.name || undefined;
  }

  public album(mbid?: string | null): IndexAlbum | undefined {
    return mbid ? this.albums.get(mbid) : undefined;
  }

  public albumOfRelease(releaseId?: string): IndexAlbum | undefined {
    const mbid = releaseId ? this.byRelease.get(releaseId) : undefined;
    return this.album(mbid);
  }

  /** Every album loaded so far. */
  public allAlbums(): IndexAlbum[] {
    return [...this.albums.values()];
  }

  /** One Lidarr's artists. */
  public artistsOf(serverId: number): IndexArtist[] {
    return [...this.artists.values()]
      .flat()
      .filter((artist) => artist.serverId === serverId);
  }

  /** One Lidarr's albums of an artist, among those loaded. */
  public loadedAlbumsOf(serverId: number, artistMbid: string): IndexAlbum[] {
    return (this.albumsByArtist.get(artistMbid) ?? []).filter(
      (album) => album.serverId === serverId
    );
  }

  /** An artist's albums, from each Lidarr that has the artist. */
  public async albumsOf(artistMbid: string): Promise<IndexAlbum[]> {
    for (const artist of this.artists.get(artistMbid) ?? []) {
      await this.loadArtist(artist.serverId, artist.id, artistMbid);
    }
    return this.albumsByArtist.get(artistMbid) ?? [];
  }

  /**
   * One Lidarr artist's albums, by Lidarr's id: asked once a run. Throws
   * when Lidarr does not answer.
   */
  public async loadArtist(
    serverId: number,
    lidarrArtistId: number,
    artistMbid: string
  ): Promise<IndexAlbum[]> {
    const key = `${serverId}:${lidarrArtistId}`;
    if (!this.loaded.has(key)) {
      const server = this.servers.find((s) => s.id === serverId);
      if (!server) return [];
      this.loaded.add(key);
      try {
        const albums = await lidarrApi(server).getAlbums({
          artistId: lidarrArtistId,
        });
        for (const album of albums) {
          this.addAlbum(serverId, album, artistMbid);
        }
      } catch (e) {
        this.complete = false;
        this.loaded.delete(key);
        throw e;
      }
    }
    return this.loadedAlbumsOf(serverId, artistMbid);
  }
}

const unique = <T>(list?: T[]): T | undefined =>
  list && list.length === 1 ? list[0] : undefined;

/** An album as one media server lists it. */
export interface ServerAlbum {
  kind: MediaServerKind;
  /** The album's id on the server. */
  itemId: string;
  title: string;
  year?: number;
  addedAt?: Date;
  /** The album's folder on disk. */
  path?: string;
  artistItemId?: string;
  artistName?: string;
  /** The artist's MusicBrainz id, as the server has it. */
  artistMbid?: string;
  /** The artist's folder on disk. */
  artistPath?: string;
  /** The album's MusicBrainz release-group id (Jellyfin, Emby). */
  releaseGroupId?: string;
  /** One release's MusicBrainz id (Jellyfin, Emby). */
  releaseId?: string;
  /** Plex's MusicBrainz id: a release's or the album's, by agent. */
  releaseOrGroupId?: string;
}

/** Where an album on a server belongs. */
export interface AlbumMatch {
  album: ServerAlbum;
  artistMbid: string;
  /** Null when the artist is known but the album could not be placed. */
  albumMbid: string | null;
  /** The album in Lidarr, when Lidarr has it. */
  lidarr?: IndexAlbum;
  /**
   * The artist is the one the server files the album under, so the
   * server's artist item is theirs. Not so for an album credited first to
   * someone else.
   */
  serversArtist: boolean;
}

/** An album Seerr already keeps, to match folders and titles against. */
export interface KnownAlbum {
  mbid: string;
  title: string;
  releaseDate?: string | null;
  folder?: string | null;
}

/** What a release or ambiguous id turned out to be. */
type Resolved =
  | { albumMbid: string; artistMbid?: string }
  /** MusicBrainz knows no such release or album. */
  | null
  /** Not known yet: MusicBrainz could not be asked this run. */
  | 'later';

const statusOf = (e: unknown): number | undefined =>
  (e as { response?: { status?: number } })?.response?.status;

const firstArtist = (group?: MbReleaseGroup | null): string | undefined =>
  group?.['artist-credit']?.[0]?.artist?.id;

/**
 * Turns release ids (and Plex's ids that may be either) into albums, at
 * most MB_CALL_CAP calls to MusicBrainz a run. What is not reached is left
 * for the next run, not stored as unmatched.
 */
export class ReleaseResolver {
  public calls = 0;
  private cap: number;
  private kept = new Map<string, unknown>();
  private answers = new Map<string, Resolved>();

  constructor(cap = MB_CALL_CAP) {
    this.cap = cap;
  }

  /** Reads what MusicBrainz said before about these ids, in one go. */
  public async preload(ids: string[]): Promise<void> {
    const keys = [
      ...new Set(
        ids
          .filter((id) => isMbid(id))
          .flatMap((id) => [`release-rg:${id}`, `rg:${id}`])
      ),
    ].filter((key) => !this.kept.has(key));
    for (let i = 0; i < keys.length; i += 400) {
      const rows = await getRepository(MusicMetadata).find({
        where: { key: In(keys.slice(i, i + 400)) },
      });
      for (const row of rows) {
        try {
          this.kept.set(row.key, JSON.parse(row.data));
        } catch {
          // A broken row is asked for again.
        }
      }
    }
  }

  public async resolve(id: string, maybeGroup: boolean): Promise<Resolved> {
    if (!isMbid(id)) return null;
    const key = `${maybeGroup ? 'either' : 'release'}:${id}`;
    if (this.answers.has(key)) return this.answers.get(key) ?? null;
    const answer = await this.resolveOnce(id, maybeGroup);
    this.answers.set(key, answer);
    return answer;
  }

  private async resolveOnce(
    id: string,
    maybeGroup: boolean
  ): Promise<Resolved> {
    const keptRelease = this.kept.get(`release-rg:${id}`) as
      | { releaseGroupId: string | null }
      | undefined;
    if (keptRelease?.releaseGroupId) {
      return {
        albumMbid: keptRelease.releaseGroupId,
        artistMbid: firstArtist(
          this.kept.get(`rg:${keptRelease.releaseGroupId}`) as MbReleaseGroup
        ),
      };
    }
    const keptGroup = this.kept.get(`rg:${id}`) as MbReleaseGroup | undefined;
    if (maybeGroup && keptGroup) {
      return { albumMbid: id, artistMbid: firstArtist(keptGroup) };
    }

    const mb = musicBrainz();
    try {
      if (this.calls >= this.cap) return 'later';
      this.calls++;
      const group = await mb.getReleaseGroupOfRelease(id, 'background');
      return group ? { albumMbid: group } : null;
    } catch (e) {
      if (statusOf(e) !== 404) return 'later';
    }
    if (!maybeGroup) return null;
    try {
      if (this.calls >= this.cap) return 'later';
      this.calls++;
      const group = await mb.getReleaseGroup(id, 'background');
      return { albumMbid: group.id ?? id, artistMbid: firstArtist(group) };
    } catch (e) {
      return statusOf(e) === 404 ? null : 'later';
    }
  }
}

/** The one known album with this folder or title, if only one. */
export const matchByFolderOrTitle = (
  album: Pick<ServerAlbum, 'path' | 'title' | 'year'>,
  candidates: KnownAlbum[]
): string | undefined => {
  const pick = (hits: KnownAlbum[]) => {
    const ids = [...new Set(hits.map((hit) => hit.mbid))];
    return ids.length === 1 ? ids[0] : undefined;
  };

  const folder = normalizeName(folderName(album.path));
  if (folder) {
    const byFolder = pick(
      candidates.filter((candidate) => {
        const year = yearOf(candidate.releaseDate);
        return (
          (candidate.folder && normalizeName(candidate.folder) === folder) ||
          normalizeName(candidate.title) === folder ||
          (year && normalizeName(`${candidate.title} ${year}`) === folder)
        );
      })
    );
    if (byFolder) return byFolder;
  }

  const title = normalizeName(album.title);
  if (!title) return undefined;
  return pick(
    candidates.filter((candidate) => {
      if (normalizeName(candidate.title) !== title) return false;
      const year = yearOf(candidate.releaseDate);
      return !album.year || !year || album.year === year;
    })
  );
};

/** Places server albums, giving up on none quietly: see the counts. */
export class AlbumMatcher {
  /** Albums whose artist could not be told. */
  public unknownArtist = 0;
  /** Albums left for the next run: MusicBrainz could not be asked. */
  public later = 0;

  constructor(
    private index: LidarrIndex,
    private resolver: ReleaseResolver,
    private known: (artistMbid: string) => Promise<KnownAlbum[]>
  ) {}

  /** The artist an album is by: the server's id, else Lidarr's artist. */
  private artistOf(album: ServerAlbum): string | undefined {
    if (isMbid(album.artistMbid)) {
      return album.artistMbid;
    }
    return (
      this.index.artistByFolder(album.artistPath) ??
      this.index.artistByName(album.artistName)
    )?.mbid;
  }

  public async match(album: ServerAlbum): Promise<AlbumMatch | undefined> {
    let artist = this.artistOf(album);
    if (artist) {
      try {
        await this.index.albumsOf(artist);
      } catch {
        // Lidarr not answering leaves the other ways of matching.
      }
    }

    let albumMbid: string | undefined;
    let creditedTo: string | undefined;

    if (album.releaseGroupId && isMbid(album.releaseGroupId)) {
      albumMbid = album.releaseGroupId;
    }

    const ambiguous = album.releaseOrGroupId;
    if (!albumMbid && ambiguous) {
      albumMbid =
        this.index.album(ambiguous)?.mbid ??
        this.index.albumOfRelease(ambiguous)?.mbid;
    }
    if (!albumMbid && album.releaseId) {
      albumMbid = this.index.albumOfRelease(album.releaseId)?.mbid;
    }
    if (!albumMbid && (ambiguous || album.releaseId)) {
      const resolved = await this.resolver.resolve(
        (ambiguous ?? album.releaseId) as string,
        !!ambiguous
      );
      if (resolved === 'later') {
        this.later++;
        return undefined;
      }
      if (resolved) {
        albumMbid = resolved.albumMbid;
        creditedTo = resolved.artistMbid;
      }
    }

    if (!albumMbid && artist) {
      const candidates = [
        ...(await this.index.albumsOf(artist).catch(() => [])),
        ...(await this.known(artist)),
      ];
      albumMbid = matchByFolderOrTitle(album, candidates);
    }

    // An album belongs to its first credited artist, as in Lidarr.
    const lidarr = this.index.album(albumMbid);
    const owner = lidarr?.artistMbid ?? creditedTo;
    const serversArtist = !owner || owner === artist;
    if (owner) {
      artist = owner;
    }

    if (!artist) {
      this.unknownArtist++;
      return undefined;
    }
    return {
      album,
      artistMbid: artist,
      albumMbid: albumMbid ?? null,
      lidarr,
      serversArtist,
    };
  }
}
