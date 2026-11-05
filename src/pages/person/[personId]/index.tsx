import PersonDetails from '@app/components/PersonDetails';
import type { NextPage } from 'next';
import { useRouter } from 'next/router';

const PersonPage: NextPage = () => {
  const router = useRouter();
  // Keyed by person so navigating between people resets state.
  return <PersonDetails key={String(router.query.personId)} />;
};

export default PersonPage;
