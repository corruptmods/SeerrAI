import MovieDetails from '@app/components/MovieDetails';
import { segment, serverDetails } from '@app/utils/titlePageProps';
import type { MovieDetails as MovieDetailsType } from '@server/models/Movie';
import type { NextPage } from 'next';
import { useRouter } from 'next/router';

interface MoviePageProps {
  movie?: MovieDetailsType;
}

const MoviePage: NextPage<MoviePageProps> = ({ movie }) => {
  const router = useRouter();
  // Keyed by title so navigating between movies resets state.
  return <MovieDetails key={String(router.query.movieId)} movie={movie} />;
};

MoviePage.getInitialProps = async (ctx) => ({
  movie: await serverDetails<MovieDetailsType>(
    ctx,
    `movie/${segment(ctx.query.movieId)}`
  ),
});

export default MoviePage;
