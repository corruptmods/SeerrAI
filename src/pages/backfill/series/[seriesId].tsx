import SeriesReview from '@app/components/Backfill/SeriesReview';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const BackfillSeriesPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return <SeriesReview />;
};

export default BackfillSeriesPage;
