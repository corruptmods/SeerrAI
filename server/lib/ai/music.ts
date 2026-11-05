import { musicBrainz } from '@server/api/musicbrainz';
import type {
  MbArtist,
  MbReleaseGroup,
} from '@server/api/musicbrainz/interfaces';
import type { User } from '@server/entity/User';
import { featureEnabled } from '@server/lib/features';
import { musicReady } from '@server/lib/music/access';
import {
  albumStatuses,
  artistStatuses,
  markBeingAdded,
} from '@server/lib/music/library';
import { rankAlbums, rankArtists } from '@server/lib/music/searchRank';
import logger from '@server/logger';
import type { MusicAlbumResult, MusicArtistResult } from '@server/models/Music';
import { mapAlbumResult, mapArtistResult } from '@server/models/Music';
import { z } from 'zod';

/*
 * Music in AI Search: the model names albums and artists apart from films
 * and series, and each is looked up on MusicBrainz as music search would.
 * Only an exact name match is shown, so a near miss never stands in.
 */

/** Max lookups per answer; MusicBrainz allows 1 request a second. */
export const AI_MUSIC_MAX = 6;

/** Music is set up and not turned off for this user. */
export const musicFor = (user: User): boolean =>
  musicReady() && featureEnabled('music', user);

const namedMusic = z.object({
  t: z.string().trim().min(1).max(200),
  /** An album's artist. */
  a: z.string().trim().max(200).nullish(),
  y: z.coerce.number().int().min(1900).max(2100).nullish().catch(null),
  k: z.enum(['album', 'artist']),
});

export type NamedMusic = z.infer<typeof namedMusic>;

/** The model's music list, dropping items that don't parse. */
export const musicReply = z
  .array(z.unknown())
  .catch([])
  .transform((items) =>
    items
      .flatMap((item) => {
        const read = namedMusic.safeParse(item);
        return read.success ? [read.data] : [];
      })
      .slice(0, AI_MUSIC_MAX)
  );

/** Comparison key ignoring case, punctuation and a leading "The". */
const nameKey = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^the /, '');

/** Credited to this artist, by the album's credit name or their own. */
const creditedTo = (group: MbReleaseGroup, artist: string) =>
  (group['artist-credit'] ?? []).some((credit) =>
    [credit.name, credit.artist.name].some(
      (name) => nameKey(name) === nameKey(artist)
    )
  );

/** Exact-name album, by its artist when given, preferring the given year. */
const findAlbum = async (named: NamedMusic) => {
  const query = named.a ? `${named.t} ${named.a}` : named.t;
  const page = await musicBrainz().searchReleaseGroups(query, { limit: 10 });
  const same = rankAlbums(page['release-groups'] ?? [], 10).filter(
    (group) =>
      nameKey(group.title) === nameKey(named.t) &&
      (!named.a || creditedTo(group, named.a))
  );
  return (
    same.find(
      (group) =>
        named.y && group['first-release-date']?.startsWith(String(named.y))
    ) ?? same[0]
  );
};

const findArtist = async (named: NamedMusic) => {
  const page = await musicBrainz().searchArtists(named.t, { limit: 10 });
  return rankArtists(page.artists ?? [], [], 10).find(
    (artist) => nameKey(artist.name) === nameKey(named.t)
  );
};

/**
 * The named albums and artists, in order, as music search shows them. Stops
 * at the first MusicBrainz error, keeping what was found by then.
 */
export const resolveMusic = async (
  named: NamedMusic[]
): Promise<{ albums: MusicAlbumResult[]; artists: MusicArtistResult[] }> => {
  const groups: MbReleaseGroup[] = [];
  const people: MbArtist[] = [];
  for (const item of named) {
    try {
      if (item.k === 'album') {
        const group = await findAlbum(item);
        if (group && !groups.some((g) => g.id === group.id)) {
          groups.push(group);
        }
      } else {
        const artist = await findArtist(item);
        if (artist && !people.some((a) => a.id === artist.id)) {
          people.push(artist);
        }
      }
    } catch (e) {
      logger.warn('AI Search could not look up music', {
        label: 'AI',
        feature: 'aiChat',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      break;
    }
  }
  const [albumStates, artistStates] = await Promise.all([
    albumStatuses(groups.map((g) => g.id)),
    artistStatuses(people.map((a) => a.id)),
  ]);
  return {
    albums: await markBeingAdded(
      groups.map((group) => mapAlbumResult(group, albumStates))
    ),
    artists: people.map((artist) => mapArtistResult(artist, artistStates)),
  };
};
