import ArtistCard from '@app/components/Music/ArtistCard';
import MusicCard from '@app/components/Music/MusicCard';
import SongCard from '@app/components/Music/SongCard';
import Slider from '@app/components/Slider';
import { ArrowRightCircleIcon } from '@heroicons/react/24/outline';
import type {
  MusicAlbumResult,
  MusicArtistResult,
  MusicPage,
  MusicSongResult,
} from '@server/models/Music';
import Link from 'next/link';
import { useEffect } from 'react';
import useSWR from 'swr';

interface MusicSliderProps {
  title: string;
  sliderKey: string;
  /** Where the row's first page comes from... */
  url?: string;
  /** ...or what it shows, already loaded. */
  items?: (MusicAlbumResult | MusicArtistResult | MusicSongResult)[];
  isLoading?: boolean;
  /** The whole list, from the row's title. */
  linkUrl?: string;
  /** Told how many it has once its first page answers (none if it failed). */
  onLoaded?: (count: number) => void;
}

/**
 * A row of albums, artists or songs. A row with nothing to show, or whose source
 * did not answer, is left out rather than shown empty.
 */
const MusicSlider = ({
  title,
  sliderKey,
  url,
  items,
  isLoading,
  linkUrl,
  onLoaded,
}: MusicSliderProps) => {
  const { data, error, mutate } = useSWR<
    MusicPage<MusicAlbumResult | MusicArtistResult | MusicSongResult>
  >(url ?? null);

  const loading = url ? !data && !error : !!isLoading;
  const results = url ? (data?.results ?? []) : (items ?? []);

  useEffect(() => {
    if (!loading) {
      onLoaded?.(results.length);
    }
  }, [loading, results.length, onLoaded]);

  if (!loading && !results.length) {
    return null;
  }

  return (
    <div>
      <div className="slider-header">
        {linkUrl ? (
          <Link href={linkUrl} className="slider-title min-w-0 pr-16">
            <span className="min-w-0 sm:truncate">{title}</span>
            <ArrowRightCircleIcon />
          </Link>
        ) : (
          <div className="slider-title">
            <span>{title}</span>
          </div>
        )}
      </div>
      <Slider
        sliderKey={sliderKey}
        isLoading={loading}
        items={results.map((item) =>
          item.mediaType === 'artist' ? (
            <ArtistCard key={`artist-${item.id}`} artist={item} />
          ) : item.mediaType === 'song' ? (
            <SongCard
              key={`song-${item.id}`}
              song={item}
              onRequested={() => mutate()}
            />
          ) : (
            <MusicCard key={`album-${item.id}`} album={item} />
          )
        )}
      />
    </div>
  );
};

export default MusicSlider;
