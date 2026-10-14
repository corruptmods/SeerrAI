import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import ArtistDetails from '@app/components/Music/ArtistDetails';
import type { NextPage } from 'next';
import { useRouter } from 'next/router';

const ArtistPage: NextPage = () => {
  const router = useRouter();
  if (!router.isReady) {
    return <LoadingSpinner />;
  }
  return (
    <ArtistDetails
      key={String(router.query.mbid)}
      artistId={String(router.query.mbid)}
    />
  );
};

export default ArtistPage;
