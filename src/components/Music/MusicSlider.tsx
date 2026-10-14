import ArtistCard from '@app/components/Music/ArtistCard';
import MusicCard from '@app/components/Music/MusicCard';
import Slider from '@app/components/Slider';
import { ArrowRightCircleIcon } from '@heroicons/react/24/outline';
import type {
  MusicAlbumResult,
  MusicArtistResult,
  MusicPage,
} from '@server/models/Music';
import Link from 'next/link';
import useSWR from 'swr';

interface MusicSliderProps {
  title: string;
  sliderKey: string;
  /** Where the row's first page comes from... */
  url?: string;
  /** ...or what it shows, already loaded. */
  items?: (MusicAlbumResult | MusicArtistResult)[];
  isLoading?: boolean;
  /** The whole list, from the row's title. */
  linkUrl?: string;
}

/**
 * A row of albums or artists. A row with nothing to show, or whose source
 * did not answer, is left out rather than shown empty.
 */
const MusicSlider = ({
  title,
  sliderKey,
  url,
  items,
  isLoading,
  linkUrl,
}: MusicSliderProps) => {
  const { data, error } = useSWR<
    MusicPage<MusicAlbumResult | MusicArtistResult>
  >(url ?? null);

  const loading = url ? !data && !error : !!isLoading;
  const results = url ? (data?.results ?? []) : (items ?? []);

  if (!loading && !results.length) {
    return null;
  }

  return (
    <div>
      <div className="slider-header">
        {linkUrl ? (
          <Link href={linkUrl} className="slider-title min-w-0 pr-16">
            <span className="truncate">{title}</span>
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
          ) : (
            <MusicCard key={`album-${item.id}`} album={item} />
          )
        )}
      />
    </div>
  );
};

export default MusicSlider;
