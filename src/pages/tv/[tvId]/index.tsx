import TvDetails from '@app/components/TvDetails';
import { segment, serverDetails } from '@app/utils/titlePageProps';
import type { TvDetails as TvDetailsType } from '@server/models/Tv';
import type { NextPage } from 'next';
import { useRouter } from 'next/router';

interface TvPageProps {
  tv?: TvDetailsType;
}

const TvPage: NextPage<TvPageProps> = ({ tv }) => {
  const router = useRouter();
  // Keyed by title so navigating between series resets state.
  return <TvDetails key={String(router.query.tvId)} tv={tv} />;
};

TvPage.getInitialProps = async (ctx) => ({
  tv: await serverDetails<TvDetailsType>(ctx, `tv/${segment(ctx.query.tvId)}`),
});

export default TvPage;
