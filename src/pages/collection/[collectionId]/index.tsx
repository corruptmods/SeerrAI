import CollectionDetails from '@app/components/CollectionDetails';
import { getHostAndPort } from '@app/utils/urlHelper';
import type { Collection } from '@server/models/Collection';
import axios from 'axios';
import type { GetServerSideProps, NextPage } from 'next';
import { useRouter } from 'next/router';

interface CollectionPageProps {
  collection?: Collection;
}

const CollectionPage: NextPage<CollectionPageProps> = ({ collection }) => {
  const router = useRouter();
  // Keyed by the collection, so going from one straight to another starts
  // afresh instead of keeping the first one's state.
  return (
    <CollectionDetails
      key={String(router.query.collectionId)}
      collection={collection}
    />
  );
};

export const getServerSideProps: GetServerSideProps<
  CollectionPageProps
> = async (ctx) => {
  const response = await axios.get<Collection>(
    `http://${getHostAndPort()}/api/v1/collection/${ctx.query.collectionId}`,
    {
      headers: ctx.req?.headers?.cookie
        ? { cookie: ctx.req.headers.cookie }
        : undefined,
    }
  );

  return {
    props: {
      collection: response.data,
    },
  };
};

export default CollectionPage;
