import TvDetails from '@app/components/TvDetails';
import { getHostAndPort } from '@app/utils/urlHelper';
import type { TvDetails as TvDetailsType } from '@server/models/Tv';
import axios from 'axios';
import type { GetServerSideProps, NextPage } from 'next';
import { useRouter } from 'next/router';

interface TvPageProps {
  tv?: TvDetailsType;
}

const TvPage: NextPage<TvPageProps> = ({ tv }) => {
  const router = useRouter();
  // Keyed by the title, so going from one series' page straight to
  // another's starts afresh instead of keeping the first one's state.
  return <TvDetails key={String(router.query.tvId)} tv={tv} />;
};

export const getServerSideProps: GetServerSideProps<TvPageProps> = async (
  ctx
) => {
  const response = await axios.get<TvDetailsType>(
    `http://${getHostAndPort()}/api/v1/tv/${ctx.query.tvId}`,
    {
      headers: ctx.req?.headers?.cookie
        ? { cookie: ctx.req.headers.cookie }
        : undefined,
    }
  );

  return {
    props: {
      tv: response.data,
    },
  };
};

export default TvPage;
