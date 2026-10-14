import { sliderTitles } from '@app/components/Discover/constants';
import { DiscoverSliderType } from '@server/constants/discover';

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

export const musicRowFor = (type?: DiscoverSliderType): MusicRow | undefined =>
  MUSIC_ROWS.find((row) => row.type === type);

export const musicRowUrl = (row: MusicRow): string =>
  `/api/v1/discover/music/${row.show}`;

export const musicRowLink = (row: MusicRow): string =>
  `/discover/music?show=${row.show}`;
