import PersonDetails from '@app/components/PersonDetails';
import type { NextPage } from 'next';
import { useRouter } from 'next/router';

const PersonPage: NextPage = () => {
  const router = useRouter();
  // Keyed by the person, so going from one straight to another starts
  // afresh (their biography folded again) instead of keeping the first
  // one's state.
  return <PersonDetails key={String(router.query.personId)} />;
};

export default PersonPage;
