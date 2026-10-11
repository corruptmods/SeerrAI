import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import type { AiFeature } from '@server/constants/features';
import { isAxiosError } from 'axios';
import useSWR from 'swr';

interface AiStatus {
  features: Partial<Record<AiFeature, boolean>>;
  /** Answers left today, or null for no limit. */
  remaining: number | null;
}

/**
 * The AI features this person has (set up by an admin, and not turned off),
 * and how many answers they have left today. Nothing is fetched until a
 * model is set up.
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
    /** After an answer: the count left has changed. */
    refresh: () => mutate(),
  };
};

/** The server's reason, which is always written to be shown. */
export const aiErrorMessage = (e: unknown, fallback: string): string =>
  (isAxiosError(e) && (e.response?.data as { message?: string })?.message) ||
  fallback;

export default useAi;
