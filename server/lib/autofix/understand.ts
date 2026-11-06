import type { User } from '@server/entity/User';
import { aiFeatureOn, askAiJson, cacheKey } from '@server/lib/ai';
import type { FixKind } from '@server/lib/autofix';
import logger from '@server/logger';
import { z } from 'zod';

/*
 * AI fallback for reports `classify` can't read. Only the report text is
 * sent (no author or title). The model can only answer a fix kind or
 * "unclear"; callers decide what to do with file-replacing kinds (confirm
 * first from Siri, leave to an admin on an issue).
 */

const KINDS = [
  'subtitles',
  'transcribe',
  'missing',
  'broken',
  'wrongEpisode',
  'replaceSeason',
  'unclear',
] as const satisfies readonly (FixKind | 'unclear')[];

const reply = z.object({
  kind: z.enum(KINDS),
  language: z
    .string()
    .regex(/^[a-z]{2}$/)
    .nullish()
    .catch(null),
  wrongSubtitles: z.boolean().nullish().catch(null),
});

export interface ReadReport {
  kind: FixKind;
  language?: string;
  replace?: boolean;
}

const DAY = 24 * 60 * 60 * 1000;
/** Truncation length; the problem is in the first few lines. */
const MOST_CHARACTERS = 600;

const SYSTEM =
  'You read a viewer’s report of a problem with a film or an episode on a home media server, and say which fix it asks for. ' +
  'subtitles: subtitles are missing, wrong, or out of sync. ' +
  'transcribe: they ask for subtitles made from the audio. ' +
  'missing: the film or episodes are not there at all. ' +
  'broken: the file will not play, or its picture or sound is bad. ' +
  'wrongEpisode: the file is a different episode or film than it should be. ' +
  'replaceSeason: a whole season is bad. ' +
  'unclear: anything else, or not a problem with the file. ' +
  'Reply with JSON only: {"kind": one of those, "language": the two-letter code of a subtitle language they name, or null, "wrongSubtitles": true when the subtitles there are wrong rather than missing}.';

/**
 * The AI's fix kind for a report, when "Understand Reports" is on. Undefined
 * if off, unclear or unavailable: a report is never acted on by a guess.
 */
export const askAboutReport = async (
  text: string,
  { user, episode }: { user: User; episode: boolean }
): Promise<ReadReport | undefined> => {
  const words = text.trim().slice(0, MOST_CHARACTERS);
  if (!words || !aiFeatureOn('aiReports', user)) return undefined;
  const prompt = `About ${episode ? 'an episode' : 'a film'}: "${words}"`;
  try {
    const answer = await askAiJson(reply, {
      feature: 'aiReports',
      user,
      system: SYSTEM,
      prompt,
      maxTokens: 60,
      cache: { key: cacheKey(user.id, prompt), ms: DAY },
    });
    if (answer.kind === 'unclear') return undefined;
    // A film has no season; replace its file instead.
    const kind =
      !episode && answer.kind === 'replaceSeason' ? 'broken' : answer.kind;
    return {
      kind,
      language: answer.language ?? undefined,
      replace: kind === 'subtitles' && answer.wrongSubtitles ? true : undefined,
    };
  } catch (e) {
    logger.debug('Could not ask the AI model about a report', {
      label: 'Auto-fix',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return undefined;
  }
};

/** Fixes that replace or remove files. */
export const REPLACES_FILES: readonly FixKind[] = [
  'broken',
  'wrongEpisode',
  'replaceSeason',
];
