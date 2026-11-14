import CollectionDetails from '@app/components/CollectionDetails';
import { segment, serverDetails } from '@app/utils/titlePageProps';
import type { Collection } from '@server/models/Collection';
import type { NextPage } from 'next';
import { useRouter } from 'next/router';

interface CollectionPageProps {
  collection?: Collection;
}

const CollectionPage: NextPage<CollectionPageProps> = ({ collection }) => {
  const router = useRouter();
  // Keyed by collection so navigating between collections resets state.
  return (
    <CollectionDetails
      key={String(router.query.collectionId)}
      collection={collection}
    />
  );
};

CollectionPage.getInitialProps = async (ctx) => ({
  collection: await serverDetails<Collection>(
    ctx,
    `collection/${segment(ctx.query.collectionId)}`
  ),
});

export default CollectionPage;
