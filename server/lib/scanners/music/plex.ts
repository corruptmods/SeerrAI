import type { PlexMusicItem } from '@server/api/plexapi';
import PlexAPI from '@server/api/plexapi';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import type { ServerAlbum } from '@server/lib/music/matcher';
import { parentPath } from '@server/lib/music/matcher';
import type { MusicSource } from '@server/lib/scanners/music/source';
import type { MusicLibrary } from '@server/lib/settings';

/*
 * Plex's music libraries, as albums to place. Plex gives an album's
 * MusicBrainz id as `mbid://<id>`, which with some agents is a release's
 * rather than the album's, so it is left to the matcher to tell. Plex lists
 * no folders for albums; for the few the ids cannot place, one track's file
 * gives the album's and artist's folders.
 */

const PAGE_SIZE = 500;

/** Albums a run may look into a track of, to find their folders. */
export const PLEX_TRACK_LOOKUPS = 100;

/** The MusicBrainz id among an item's ids, if Plex has one. */
export const plexMbid = (item?: PlexMusicItem | null): string | undefined =>
  item?.Guid?.map((guid) => guid.id)
    .find((id) => id.startsWith('mbid://'))
    ?.slice('mbid://'.length)
    .toLowerCase();

export class PlexMusicSource implements MusicSource {
  private artists = new Map<string, PlexMusicItem | undefined>();
  private lookups = 0;

  private constructor(private client: PlexAPI) {}

  /** As the owner, whose Plex token Seerr reads Plex with. */
  public static async open(): Promise<PlexMusicSource> {
    const admin = await getRepository(User).findOne({
      select: { id: true, plexToken: true },
      where: { id: 1 },
    });
    if (!admin?.plexToken) {
      throw new Error('The owner has no Plex account linked.');
    }
    return new PlexMusicSource(new PlexAPI({ plexToken: admin.plexToken }));
  }

  public async albums(
    library: MusicLibrary,
    { since }: { since?: number }
  ): Promise<ServerAlbum[]> {
    let albums: PlexMusicItem[];
    if (since === undefined) {
      for (const artist of await this.all(library.id, 'artist')) {
        this.artists.set(artist.ratingKey, artist);
      }
      albums = await this.all(library.id, 'album');
    } else {
      albums = await this.client.getRecentlyAddedAlbums(library.id, since);
      for (const key of new Set(albums.map((a) => a.parentRatingKey))) {
        if (key && !this.artists.has(key)) {
          this.artists.set(key, await this.client.getMusicItem(key));
        }
      }
    }
    return albums.map((album) => this.toServerAlbum(album));
  }

  private async all(
    sectionId: string,
    type: 'artist' | 'album'
  ): Promise<PlexMusicItem[]> {
    const items: PlexMusicItem[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await this.client.getMusicItems(sectionId, type, {
        offset,
        size: PAGE_SIZE,
      });
      items.push(...page.items);
      if (page.items.length < PAGE_SIZE || items.length >= page.totalSize) {
        return items;
      }
    }
  }

  private toServerAlbum(album: PlexMusicItem): ServerAlbum {
    const artist = album.parentRatingKey
      ? this.artists.get(album.parentRatingKey)
      : undefined;
    return {
      kind: 'plex',
      itemId: album.ratingKey,
      title: album.title,
      year: album.year,
      addedAt: album.addedAt ? new Date(album.addedAt * 1000) : undefined,
      trackCount: album.leafCount,
      artistItemId: album.parentRatingKey,
      artistName: album.parentTitle ?? artist?.title,
      artistMbid: plexMbid(artist),
      artistPath: artist?.Location?.[0]?.path,
      releaseOrGroupId: plexMbid(album),
    };
  }

  public async fillPaths(album: ServerAlbum): Promise<boolean> {
    if (album.path || this.lookups >= PLEX_TRACK_LOOKUPS) {
      return false;
    }
    this.lookups++;
    const tracks = await this.client.getAlbumTracks(album.itemId);
    const file = tracks
      .flatMap((track) => track.Media ?? [])
      .flatMap((media) => media.Part ?? [])
      .find((part) => part.file)?.file;
    album.path = parentPath(file);
    if (!album.path) return false;
    album.artistPath ??= parentPath(album.path);
    return true;
  }
}
