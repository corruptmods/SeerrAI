import TitleCard from '@app/components/TitleCard';
import useNearScreen, { useLoadWhenNear } from '@app/hooks/useNearScreen';
import { Permission, useUser } from '@app/hooks/useUser';
import type { MovieDetails } from '@server/models/Movie';
import type { TvDetails } from '@server/models/Tv';
import useSWR from 'swr';

export interface TmdbTitleCardProps {
  id: number;
  tmdbId: number;
  tvdbId?: number;
  type: 'movie' | 'tv';
  canExpand?: boolean;
  isAddedToWatchlist?: boolean;
  mutateParent?: () => void;
}

const isMovie = (movie: MovieDetails | TvDetails): movie is MovieDetails => {
  return (movie as MovieDetails).title !== undefined;
};

const TmdbTitleCard = ({
  id,
  tmdbId,
  tvdbId,
  type,
  canExpand,
  isAddedToWatchlist = false,
  mutateParent,
}: TmdbTitleCardProps) => {
  const { hasPermission } = useUser();

  // The title loads once the card is near the screen, so it is ready (and
  // its poster with it) by the time it is scrolled to.
  const { ref, near } = useNearScreen();
  const url =
    type === 'movie' ? `/api/v1/movie/${tmdbId}` : `/api/v1/tv/${tmdbId}`;
  const titleKey = useLoadWhenNear(url, near);
  const { data: title, error } = useSWR<MovieDetails | TvDetails>(titleKey);

  if (!title && !error) {
    return (
      <div ref={ref}>
        <TitleCard.Placeholder canExpand={canExpand} />
      </div>
    );
  }

  if (!title) {
    return hasPermission(Permission.ADMIN) ? (
      <TitleCard.ErrorCard
        id={id}
        tmdbId={tmdbId}
        tvdbId={tvdbId}
        type={type}
      />
    ) : null;
  }

  return isMovie(title) ? (
    <TitleCard
      key={title.id}
      id={title.id}
      isAddedToWatchlist={
        title.mediaInfo?.watchlists?.length || isAddedToWatchlist
      }
      image={title.posterPath}
      backdrop={title.backdropPath}
      status={title.mediaInfo?.status}
      summary={title.overview}
      title={title.title}
      userScore={title.voteAverage}
      year={title.releaseDate}
      mediaType={'movie'}
      canExpand={canExpand}
      mutateParent={mutateParent}
    />
  ) : (
    <TitleCard
      key={title.id}
      id={title.id}
      isAddedToWatchlist={
        title.mediaInfo?.watchlists?.length || isAddedToWatchlist
      }
      image={title.posterPath}
      backdrop={title.backdropPath}
      status={title.mediaInfo?.status}
      summary={title.overview}
      title={title.name}
      userScore={title.voteAverage}
      year={title.firstAirDate}
      mediaType={'tv'}
      canExpand={canExpand}
      mutateParent={mutateParent}
    />
  );
};

export default TmdbTitleCard;
