import { musicBrainz } from '@server/api/musicbrainz';
import type { MbReleaseGroup } from '@server/api/musicbrainz/interfaces';
import type MusicAlbum from '@server/entity/MusicAlbum';

/*
 * What a music request needs to know about the albums asked for: their
 * titles, kinds and dates, kept on the request and the artist's albums so
 * cards and notifications never have to ask MusicBrainz. Each album has to
 * be the artist's own, so nobody can attach someone else's album to an
 * artist.
 */

/** An album as a request keeps it. */
export interface RequestedAlbum {
  mbId: string;
  title: string;
  primaryType?: string | null;
  secondaryTypes: string[];
  releaseDate?: string | null;
}

/** An album asked for that MusicBrainz does not list under the artist. */
export class NotTheArtistsAlbumError extends Error {}

const fromReleaseGroup = (group: MbReleaseGroup): RequestedAlbum => ({
  mbId: group.id,
  title: group.title,
  primaryType: group['primary-type'] ?? null,
  secondaryTypes: group['secondary-types'] ?? [],
  releaseDate: group['first-release-date'] || null,
});

const credits = (group: MbReleaseGroup, artistMbid: string): boolean =>
  (group['artist-credit'] ?? []).some(
    (credit) => credit.artist.id === artistMbid
  );

/**
 * The artist's name and the albums asked for, in the order asked. Albums
 * already known (on the artist, or in what MusicBrainz said about the
 * artist's albums when their page was opened) cost nothing; any other is
 * looked up, and must credit the artist.
 */
export const resolveRequestAlbums = async (
  artistMbid: string,
  albumMbids: string[],
  known: MusicAlbum[] = []
): Promise<{ artistName: string; albums: RequestedAlbum[] }> => {
  const mb = musicBrainz();
  const artist = await mb.getArtist(artistMbid);

  const byId = new Map<string, RequestedAlbum>();
  for (const album of known) {
    if (album.mbId) {
      byId.set(album.mbId, {
        mbId: album.mbId,
        title: album.title,
        primaryType: album.primaryType,
        secondaryTypes: album.secondaryTypes ?? [],
        releaseDate: album.releaseDate,
      });
    }
  }
  const listed = albumMbids.some((id) => !byId.has(id))
    ? await mb.keptArtistReleaseGroups(artistMbid)
    : [];
  for (const group of listed) {
    if (!byId.has(group.id)) {
      byId.set(group.id, fromReleaseGroup(group));
    }
  }

  const albums: RequestedAlbum[] = [];
  for (const id of albumMbids) {
    let album = byId.get(id);
    if (!album) {
      const group = await mb.getReleaseGroup(id);
      if (!credits(group, artistMbid)) {
        throw new NotTheArtistsAlbumError(
          `${group.title} is not an album of ${artist.name}.`
        );
      }
      album = fromReleaseGroup(group);
    }
    albums.push(album);
  }

  return { artistName: artist.name, albums };
};
