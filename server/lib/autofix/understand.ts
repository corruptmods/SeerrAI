import type { User } from '@server/entity/User';
import { aiFeatureOn, askAiJson, cacheKey } from '@server/lib/ai';
import type { FixKind } from '@server/lib/autofix';
import logger from '@server/logger';
import { z } from 'zod';

/*
 * A report the word rules (classify) can't read, read by the AI model:
 * which fix it asks for, if any. Only the report's words are sent, never
 * who wrote it or the title. The answer is one of the fix kinds or
 * "unclear", so whatever a report says, the model can only choose among
 * those; what is then done with a fix that replaces files is up to the
 * caller (asked first from Siri, left for an admin on an issue).
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
/** Longer reports are cut here: the problem is in the first few lines. */
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
 * Which fix a report asks for, by the AI model, when "Understand Reports"
 * is on for this person. Undefined when it's off, unclear, or the model
 * couldn't be asked: a report is never acted on by a guess.
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
      cache: { key: cacheKey(prompt), ms: DAY },
    });
    if (answer.kind === 'unclear') return undefined;
    // A film has no season to replace: its one file is.
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
