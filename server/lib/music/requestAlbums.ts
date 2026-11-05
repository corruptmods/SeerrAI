import { musicBrainz } from '@server/api/musicbrainz';
import type { MbReleaseGroup } from '@server/api/musicbrainz/interfaces';
import type MusicAlbum from '@server/entity/MusicAlbum';

/*
 * Album details are stored on the request so cards and notifications don't
 * query MusicBrainz. Each album must credit the artist, so nobody can attach
 * another artist's album.
 */

/** Album details stored on a request. */
export interface RequestedAlbum {
  mbId: string;
  title: string;
  primaryType?: string | null;
  secondaryTypes: string[];
  releaseDate?: string | null;
}

/** Requested album that MusicBrainz doesn't credit to the artist. */
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
 * Returns the artist's name and the requested albums in order. Known albums
 * (stored, or cached from the artist page) are free; others are looked up
 * and must credit the artist.
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
