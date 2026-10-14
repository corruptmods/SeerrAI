import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import AlbumDetails from '@app/components/Music/AlbumDetails';
import type { NextPage } from 'next';
import { useRouter } from 'next/router';

const AlbumPage: NextPage = () => {
  const router = useRouter();
  if (!router.isReady) {
    return <LoadingSpinner />;
  }
  return (
    <AlbumDetails
      key={String(router.query.mbid)}
      albumId={String(router.query.mbid)}
    />
  );
};

export default AlbumPage;
