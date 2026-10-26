import { sliderTitles } from '@app/components/Discover/constants';
import defineMessages from '@app/utils/defineMessages';
import { DiscoverSliderType } from '@server/constants/discover';

const messages = defineMessages('components.Music.musicRows', {
  yourRequests: 'Your Music Requests',
  moreFromYourArtists: 'More from Your Artists',
  artistsLikeYours: 'Artists Like Yours',
});

/*
 * Music's Discover rows: each row's list on the server, and its title. The
 * music page (/discover/music) shows them all, and each in full.
 */

export const MUSIC_ROWS = [
  {
    type: DiscoverSliderType.MUSIC_RECENTLY_ADDED,
    show: 'recently-added',
    title: sliderTitles.musicRecentlyAdded,
  },
  {
    type: DiscoverSliderType.MUSIC_NEW_RELEASES,
    show: 'new-releases',
    title: sliderTitles.musicNewReleases,
  },
  {
    type: DiscoverSliderType.MUSIC_POPULAR_ALBUMS,
    show: 'popular-albums',
    title: sliderTitles.musicPopularAlbums,
  },
  {
    type: DiscoverSliderType.MUSIC_POPULAR_ARTISTS,
    show: 'popular-artists',
    title: sliderTitles.musicPopularArtists,
  },
] as const;

export type MusicRow = (typeof MUSIC_ROWS)[number];

/**
 * Each person's own rows, from the music they have asked for, above the
 * rest on the Music page; empty, and so not shown, until they ask for some.
 */
export const PERSONAL_MUSIC_ROWS = [
  { show: 'your-requests', title: messages.yourRequests },
  { show: 'more-from-your-artists', title: messages.moreFromYourArtists },
  { show: 'artists-like-yours', title: messages.artistsLikeYours },
] as const;

type AnyMusicRow = MusicRow | (typeof PERSONAL_MUSIC_ROWS)[number];

export const musicRowFor = (type?: DiscoverSliderType): MusicRow | undefined =>
  MUSIC_ROWS.find((row) => row.type === type);

export const musicRowUrl = (row: AnyMusicRow): string =>
  `/api/v1/discover/music/${row.show}`;

export const musicRowLink = (row: AnyMusicRow): string =>
  `/discover/music?show=${row.show}`;
