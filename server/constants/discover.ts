import type DiscoverSlider from '@server/entity/DiscoverSlider';

export enum DiscoverSliderType {
  RECENTLY_ADDED = 1,
  RECENT_REQUESTS,
  PLEX_WATCHLIST,
  TRENDING,
  POPULAR_MOVIES,
  MOVIE_GENRES,
  UPCOMING_MOVIES,
  STUDIOS,
  POPULAR_TV,
  TV_GENRES,
  UPCOMING_TV,
  NETWORKS,
  TMDB_MOVIE_KEYWORD,
  TMDB_MOVIE_GENRE,
  TMDB_TV_KEYWORD,
  TMDB_TV_GENRE,
  TMDB_SEARCH,
  TMDB_STUDIO,
  TMDB_NETWORK,
  TMDB_MOVIE_STREAMING_SERVICES,
  TMDB_TV_STREAMING_SERVICES,
  SUGGESTED,
  /** What Maintainerr is about to delete; empty rows are not shown. */
  DELETING_SOON,
  /** Anime airing this season; its own page also has other seasons. */
  ANIME,
  /*
   * Music, shown only once Lidarr is set up and to people with music on.
   * New albums come from ListenBrainz; Top Albums and Top Artists (named
   * Popular before) and Top Songs and Trending from Apple Music's charts;
   * Recently Added from Seerr's own scans.
   */
  MUSIC_RECENTLY_ADDED,
  MUSIC_NEW_RELEASES,
  MUSIC_POPULAR_ALBUMS,
  MUSIC_POPULAR_ARTISTS,
  MUSIC_TOP_SONGS,
  MUSIC_TRENDING,
}

/** Music's rows, which only show once music is ready. */
export const MUSIC_SLIDERS: readonly DiscoverSliderType[] = [
  DiscoverSliderType.MUSIC_RECENTLY_ADDED,
  DiscoverSliderType.MUSIC_NEW_RELEASES,
  DiscoverSliderType.MUSIC_POPULAR_ALBUMS,
  DiscoverSliderType.MUSIC_POPULAR_ARTISTS,
  DiscoverSliderType.MUSIC_TOP_SONGS,
  DiscoverSliderType.MUSIC_TRENDING,
];

export const defaultSliders: Partial<DiscoverSlider>[] = [
  // First: the one row that is time-sensitive.
  {
    type: DiscoverSliderType.DELETING_SOON,
    enabled: true,
    isBuiltIn: true,
    order: 0,
  },
  {
    type: DiscoverSliderType.RECENTLY_ADDED,
    enabled: true,
    isBuiltIn: true,
    order: 1,
  },
  {
    type: DiscoverSliderType.RECENT_REQUESTS,
    enabled: true,
    isBuiltIn: true,
    order: 2,
  },
  {
    type: DiscoverSliderType.PLEX_WATCHLIST,
    enabled: true,
    isBuiltIn: true,
    order: 3,
  },
  {
    type: DiscoverSliderType.SUGGESTED,
    enabled: true,
    isBuiltIn: true,
    order: 4,
  },
  {
    type: DiscoverSliderType.TRENDING,
    enabled: true,
    isBuiltIn: true,
    order: 5,
  },
  {
    type: DiscoverSliderType.POPULAR_MOVIES,
    enabled: true,
    isBuiltIn: true,
    order: 6,
  },
  {
    type: DiscoverSliderType.MOVIE_GENRES,
    enabled: true,
    isBuiltIn: true,
    order: 7,
  },
  {
    type: DiscoverSliderType.UPCOMING_MOVIES,
    enabled: true,
    isBuiltIn: true,
    order: 8,
  },
  {
    type: DiscoverSliderType.STUDIOS,
    enabled: true,
    isBuiltIn: true,
    order: 9,
  },
  {
    type: DiscoverSliderType.POPULAR_TV,
    enabled: true,
    isBuiltIn: true,
    order: 10,
  },
  {
    type: DiscoverSliderType.TV_GENRES,
    enabled: true,
    isBuiltIn: true,
    order: 11,
  },
  {
    type: DiscoverSliderType.UPCOMING_TV,
    enabled: true,
    isBuiltIn: true,
    order: 12,
  },
  {
    type: DiscoverSliderType.ANIME,
    enabled: true,
    isBuiltIn: true,
    order: 13,
  },
  {
    type: DiscoverSliderType.NETWORKS,
    enabled: true,
    isBuiltIn: true,
    order: 14,
  },
  // Music, after everything else; they show once Lidarr is set up.
  {
    type: DiscoverSliderType.MUSIC_RECENTLY_ADDED,
    enabled: true,
    isBuiltIn: true,
    order: 15,
  },
  {
    type: DiscoverSliderType.MUSIC_NEW_RELEASES,
    enabled: true,
    isBuiltIn: true,
    order: 16,
  },
  // The charts' songs before their albums and artists.
  {
    type: DiscoverSliderType.MUSIC_TOP_SONGS,
    enabled: true,
    isBuiltIn: true,
    order: 17,
  },
  {
    type: DiscoverSliderType.MUSIC_TRENDING,
    enabled: true,
    isBuiltIn: true,
    order: 18,
  },
  {
    type: DiscoverSliderType.MUSIC_POPULAR_ALBUMS,
    enabled: true,
    isBuiltIn: true,
    order: 19,
  },
  {
    type: DiscoverSliderType.MUSIC_POPULAR_ARTISTS,
    enabled: true,
    isBuiltIn: true,
    order: 20,
  },
];
