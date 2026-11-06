import type { AiFeature } from '@server/constants/features';
import { getRepository } from '@server/datasource';
import AiUsage from '@server/entity/AiUsage';
import type { User } from '@server/entity/User';
import { forgetRecentActivity } from '@server/lib/ai/context';
import { noteAnswer, noteFailure } from '@server/lib/ai/credit';
import { today } from '@server/lib/ai/day';
import type { CompletionImage } from '@server/lib/ai/providers';
import { AiProviderError, complete } from '@server/lib/ai/providers';
import { featureEnabled } from '@server/lib/features';
import { Permission } from '@server/lib/permissions';
import { aiReady, getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isUniqueViolation } from '@server/utils/isUniqueViolation';
import { createHash } from 'node:crypto';
import { LessThan } from 'typeorm';
import type { z } from 'zod';

/*
 * Every AI feature goes through here: availability per user, the model,
 * the daily limit, and a cache so a repeat question costs nothing.
 */

/**
 * An error shown to the user, with its HTTP status. `code` lets the page
 * translate it; the message is the English fallback.
 */
export class AiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly values?: Record<string, string | number>
  ) {
    super(message);
  }
}

/** Set up by an admin, and not turned off for everyone or by this user. */
export const aiFeatureOn = (feature: AiFeature, user?: User | null) =>
  aiReady(getSettings().ai) && featureEnabled(feature, user);

export const modelFor = (feature: AiFeature): string => {
  const ai = getSettings().ai;
  return ai.featureModels?.[feature]?.trim() || ai.model.trim();
};

// ---- the daily limit ------------------------------------------------------

// Server-local day, since the limit resets at local midnight.
export { today };

const isUnlimited = (user: User) =>
  user.hasPermission(Permission.ADMIN) || !getSettings().ai.dailyLimit;

export const usedToday = async (user: User): Promise<number> =>
  (
    await getRepository(AiUsage).findOne({
      where: { userId: user.id, day: today() },
    })
  )?.uses ?? 0;

/** Answers left today, or null for no limit. */
export const remainingToday = async (user: User): Promise<number | null> =>
  isUnlimited(user)
    ? null
    : Math.max(0, getSettings().ai.dailyLimit - (await usedToday(user)));

/**
 * Takes one of today's answers before the model is asked, or throws if none
 * are left. One conditional update, so concurrent requests cannot all get
 * through. Returns a refund for when the provider fails.
 */
export const reserveUse = async (user: User): Promise<() => Promise<void>> => {
  if (isUnlimited(user)) {
    return async () => undefined;
  }
  const limit = getSettings().ai.dailyLimit;
  const repository = getRepository(AiUsage);
  const day = today();
  const where = { userId: user.id, day };

  try {
    await repository.insert({ ...where, uses: 0 });
    // Only today's row matters; a week is kept in case the clock moves.
    const weekAgo = today(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
    await repository.delete({ day: LessThan(weekAgo) });
  } catch (e) {
    if (!isUniqueViolation(e)) {
      throw e;
    }
  }

  const taken = await repository
    .createQueryBuilder()
    .update(AiUsage)
    .set({ uses: () => 'uses + 1' })
    .where('userId = :userId AND day = :day AND uses < :limit', {
      ...where,
      limit,
    })
    .execute();
  if (!taken.affected) {
    throw new AiError(
      `You have used all ${limit} of today's AI answers. More are available tomorrow.`,
      429,
      'limit',
      { limit }
    );
  }
  return async () => {
    await repository
      .createQueryBuilder()
      .update(AiUsage)
      .set({ uses: () => 'uses - 1' })
      .where('userId = :userId AND day = :day AND uses > 0', where)
      .execute();
  };
};

// ---- the cache ------------------------------------------------------------

const CACHE_LIMIT = 500;
const cache = new Map<string, { until: number; value: string }>();

const cached = (key: string): string | undefined => {
  const hit = cache.get(key);
  if (!hit) {
    return undefined;
  }
  if (hit.until < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
};

const remember = (key: string, value: string, ms: number) => {
  if (cache.size >= CACHE_LIMIT) {
    // Evict the oldest; a Map keeps insertion order.
    cache.delete(cache.keys().next().value as string);
  }
  cache.set(key, { until: Date.now() + ms, value });
};

/** Clears every cached answer, as when the model changes. */
export const clearAiCache = () => {
  cache.clear();
  forgetRecentActivity();
};

/** A short, stable cache key from any parts. */
export const cacheKey = (...parts: unknown[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('base64url');

// ---- asking ---------------------------------------------------------------

export interface AiRequest {
  feature: AiFeature;
  user: User;
  system: string;
  prompt: string;
  /** An image for the model; include its hash in the cache key. */
  image?: CompletionImage;
  maxTokens: number;
  /** Reuse the answer for this key for `ms`. */
  cache?: { key: string; ms: number };
  /**
   * Refund for an answer already reserved with reserveUse, by a feature
   * with work to do first (reading a photo). Called if the answer comes
   * from the cache or the provider fails, unless it timed out.
   */
  paid?: () => Promise<void>;
}

/**
 * One answer from the model. `charge` is false for a retry already paid
 * for.
 */
const ask = async (
  req: AiRequest,
  json: boolean,
  charge = true
): Promise<string> => {
  const free = async () => undefined;
  const paid = charge ? req.paid : undefined;
  if (!aiFeatureOn(req.feature, req.user)) {
    await paid?.();
    throw new AiError('This AI feature is turned off.', 403, 'off');
  }
  const model = modelFor(req.feature);
  const key = req.cache && `${req.feature}:${model}:${req.cache.key}`;
  const hit = key ? cached(key) : undefined;
  if (hit !== undefined) {
    // A cached repeat costs nothing.
    await paid?.();
    return hit;
  }

  const refund = !charge ? free : (paid ?? (await reserveUse(req.user)));
  let answer;
  try {
    answer = await complete(getSettings().ai, {
      model,
      system: req.system,
      prompt: req.prompt,
      image: req.image,
      maxTokens: req.maxTokens,
      json,
    });
  } catch (e) {
    // A request that timed out may still be answered and billed, so it
    // counts like an answer.
    if (!(e instanceof AiProviderError && e.code === 'timeout')) {
      await refund();
    }
    noteFailure(e);
    throw e;
  }
  noteAnswer(model, answer);
  logger.debug('AI answer', {
    label: 'AI',
    feature: req.feature,
    model,
    inputTokens: answer.inputTokens,
    outputTokens: answer.outputTokens,
  });

  // An empty answer still counts: the provider billed it, and refunding it
  // would allow endless free empty answers.
  if (!answer.text) {
    throw new AiError(
      'The model gave an empty answer. Try again.',
      502,
      'empty'
    );
  }
  if (key && req.cache) {
    remember(key, answer.text, req.cache.ms);
  }
  return answer.text;
};

/** A plain-text answer. */
export const askAi = async (req: AiRequest): Promise<string> => ask(req, false);

/** The first JSON object in a reply, fenced or not. */
export const extractJson = (text: string): unknown => {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new SyntaxError('No JSON object in the reply.');
  }
  return JSON.parse(text.slice(start, end + 1));
};

const isShownError = (e: unknown) =>
  e instanceof AiError ||
  typeof (e as { status?: number })?.status === 'number';

/**
 * A JSON answer checked against `schema`. An unreadable reply is never
 * cached and is retried once at no charge. If that fails too, the answer
 * still counts: both replies were billed, and refunding would let anyone
 * dodge the limit by wording questions so replies can't be read.
 */
export const askAiJson = async <T>(
  schema: z.ZodType<T>,
  req: AiRequest
): Promise<T> => {
  const key = req.cache
    ? `${req.feature}:${modelFor(req.feature)}:${req.cache.key}`
    : undefined;
  const forget = () => key && cache.delete(key);
  const first = await ask(req, true);
  try {
    return schema.parse(extractJson(first));
  } catch {
    forget();
  }
  try {
    const again = await ask(
      { ...req, prompt: `${req.prompt}\n\nReply with the JSON object only.` },
      true,
      false
    );
    return schema.parse(extractJson(again));
  } catch (e) {
    forget();
    if (isShownError(e)) {
      throw e;
    }
    throw new AiError(
      'The model did not answer in a form Seerr could read. Try again, or choose a stronger model.',
      502,
      'unreadable'
    );
  }
};
