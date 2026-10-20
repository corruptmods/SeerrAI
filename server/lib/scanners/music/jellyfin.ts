import type JellyfinAPI from '@server/api/jellyfin';
import type { JellyfinMusicItem } from '@server/api/jellyfin';
import type { JellyfinFamilyKind } from '@server/constants/server';
import { jellyfinClient } from '@server/lib/mediaServers';
import type { ServerAlbum } from '@server/lib/music/matcher';
import { parentPath } from '@server/lib/music/matcher';
import type { MusicSource } from '@server/lib/scanners/music/source';
import type { MusicLibrary } from '@server/lib/settings';

/*
 * Jellyfin's and Emby's music libraries, as albums to place. Both keep the
 * MusicBrainz ids from the files' tags: the album's (release group), one
 * release's, and the album artist's. Albums also come with their folders.
 */

const PAGE_SIZE = 500;

/** A provider id, whatever its case; the first when several are given. */
export const providerId = (
  item: JellyfinMusicItem | undefined,
  name: string
): string | undefined => {
  const key = Object.keys(item?.ProviderIds ?? {}).find(
    (k) => k.toLowerCase() === name.toLowerCase()
  );
  const value = key ? item?.ProviderIds?.[key] : undefined;
  return value?.split(/[/;,]/)[0]?.trim().toLowerCase() || undefined;
};

export class JellyfinMusicSource implements MusicSource {
  private artists = new Map<string, JellyfinMusicItem>();

  private constructor(
    private client: JellyfinAPI,
    private kind: JellyfinFamilyKind
  ) {}

  public static async open(
    kind: JellyfinFamilyKind
  ): Promise<JellyfinMusicSource> {
    return new JellyfinMusicSource(
      await jellyfinClient(kind, { asAdmin: true }),
      kind
    );
  }

  public async albums(
    library: MusicLibrary,
    { since }: { since?: number }
  ): Promise<ServerAlbum[]> {
    const albums: JellyfinMusicItem[] = [];
    for (let start = 0; ; start += PAGE_SIZE) {
      const page = await this.client.getMusicItems(library.id, {
        start,
        limit: PAGE_SIZE,
        newestFirst: since !== undefined,
      });
      let older = false;
      for (const item of page.Items) {
        if (
          since !== undefined &&
          item.DateCreated &&
          new Date(item.DateCreated).getTime() < since
        ) {
          older = true;
          break;
        }
        if (item.Type === 'MusicArtist') {
          this.artists.set(item.Id, item);
        } else if (item.Type === 'MusicAlbum') {
          albums.push(item);
        }
      }
      if (
        older ||
        page.Items.length < PAGE_SIZE ||
        start + PAGE_SIZE >= page.TotalRecordCount
      ) {
        break;
      }
    }
    return albums.map((album) => this.toServerAlbum(album));
  }

  private toServerAlbum(album: JellyfinMusicItem): ServerAlbum {
    const credited = album.AlbumArtists?.[0];
    const artist = credited ? this.artists.get(credited.Id) : undefined;
    return {
      kind: this.kind,
      itemId: album.Id,
      title: album.Name,
      year: album.ProductionYear,
      addedAt: album.DateCreated ? new Date(album.DateCreated) : undefined,
      path: album.Path,
      artistItemId: credited?.Id,
      artistName: credited?.Name ?? album.AlbumArtist,
      artistMbid:
        providerId(album, 'MusicBrainzAlbumArtist') ??
        providerId(artist, 'MusicBrainzArtist') ??
        providerId(album, 'MusicBrainzArtist'),
      artistPath: artist?.Path ?? parentPath(album.Path),
      releaseGroupId: providerId(album, 'MusicBrainzReleaseGroup'),
      releaseId: providerId(album, 'MusicBrainzAlbum'),
    };
  }
}
