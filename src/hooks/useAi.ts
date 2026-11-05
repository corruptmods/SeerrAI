import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import aiErrorMessage from '@app/utils/aiErrorMessage';
import type { AiFeature } from '@server/constants/features';
import useSWR from 'swr';

interface AiStatus {
  features: Partial<Record<AiFeature, boolean>>;
  /** Answers left today; null for unlimited. */
  remaining: number | null;
}

/**
 * The user's enabled AI features and answers left today. Fetches nothing
 * until a model is set up.
 */
const useAi = () => {
  const { currentSettings } = useSettings();
  const { user } = useUser();
  const { data, mutate } = useSWR<AiStatus>(
    currentSettings.aiReady && user ? '/api/v1/ai/status' : null,
    { revalidateOnFocus: false }
  );
  return {
    on: (feature: AiFeature) => !!data?.features[feature],
    remaining: data?.remaining ?? null,
    /** Call after an answer to refresh the count. */
    refresh: () => mutate(),
  };
};

export { aiErrorMessage };

export default useAi;
