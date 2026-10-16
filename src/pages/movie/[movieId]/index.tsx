import MovieDetails from '@app/components/MovieDetails';
import { getHostAndPort } from '@app/utils/urlHelper';
import type { MovieDetails as MovieDetailsType } from '@server/models/Movie';
import axios from 'axios';
import type { GetServerSideProps, NextPage } from 'next';
import { useRouter } from 'next/router';

interface MoviePageProps {
  movie?: MovieDetailsType;
}

const MoviePage: NextPage<MoviePageProps> = ({ movie }) => {
  const router = useRouter();
  // Keyed by the title, so going from one movie's page straight to
  // another's starts afresh instead of keeping the first one's state (its
  // watchlist button, an open panel).
  return <MovieDetails key={String(router.query.movieId)} movie={movie} />;
};

export const getServerSideProps: GetServerSideProps<MoviePageProps> = async (
  ctx
) => {
  const response = await axios.get<MovieDetailsType>(
    `http://${getHostAndPort()}/api/v1/movie/${ctx.query.movieId}`,
    {
      headers: ctx.req?.headers?.cookie
        ? { cookie: ctx.req.headers.cookie }
        : undefined,
    }
  );

  return {
    props: {
      movie: response.data,
    },
  };
};

export default MoviePage;
