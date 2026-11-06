import TitleCard from '@app/components/TitleCard';
import type { MovieResult, TvResult } from '@server/models/Search';

/** Standard title card for an AI result. */
const AiTitleCard = ({ result }: { result: MovieResult | TvResult }) => (
  <TitleCard
    id={result.id}
    image={result.posterPath}
    status={result.mediaInfo?.status}
    outsideLibraries={result.mediaInfo?.outsideLibraries}
    summary={result.overview}
    title={result.mediaType === 'movie' ? result.title : result.name}
    userScore={result.voteAverage}
    year={
      result.mediaType === 'movie' ? result.releaseDate : result.firstAirDate
    }
    mediaType={result.mediaType}
    inProgress={(result.mediaInfo?.downloadStatus ?? []).length > 0}
    isAddedToWatchlist={result.mediaInfo?.watchlists?.length ?? 0}
    canExpand
  />
);

/** "Title (year)", the form the model is told it offered. */
export const resultLabel = (result: MovieResult | TvResult) => {
  const name = result.mediaType === 'movie' ? result.title : result.name;
  const year = (
    result.mediaType === 'movie' ? result.releaseDate : result.firstAirDate
  )?.slice(0, 4);
  return year ? `${name} (${year})` : name;
};

export default AiTitleCard;
