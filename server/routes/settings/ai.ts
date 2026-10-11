import type { AiFeature } from '@server/constants/features';
import { AI_FEATURES } from '@server/constants/features';
import { clearAiCache } from '@server/lib/ai';
import {
  clearOutOfCredit,
  creditReport,
  forgetSpendReports,
  providerSpend,
} from '@server/lib/ai/credit';
import { billedBy, complete, listModels } from '@server/lib/ai/providers';
import type { AiSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { Router } from 'express';
import { z } from 'zod';

/*
 * Settings → AI. The API key is write-only: once saved it is never sent back
 * to a browser, and leaving the field empty keeps the saved one.
 */
const aiSettingsRoutes = Router();

const body = z.object({
  enabled: z.boolean(),
  provider: z.enum(['anthropic', 'openai']),
  /** Empty keeps the saved key. */
  apiKey: z.string().trim().max(500).optional(),
  removeApiKey: z.boolean().optional(),
  baseUrl: z
    .string()
    .trim()
    .max(300)
    .refine((v) => v === '' || /^https?:\/\/\S+$/i.test(v), {
      message: 'The server address must start with http:// or https://',
    }),
  model: z.string().trim().max(200),
  featureModels: z
    .record(z.string(), z.string().trim().max(200))
    .transform((models) =>
      Object.fromEntries(
        Object.entries(models).filter(
          ([feature, model]) =>
            (AI_FEATURES as readonly string[]).includes(feature) && model
        )
      )
    ),
  dailyLimit: z.number().int().min(0).max(10_000),
});

/** What the browser sees: everything but the key. */
const visible = (ai: AiSettings) => ({
  ...ai,
  apiKey: '',
  hasApiKey: !!ai.apiKey,
});

/**
 * The settings as they would be saved. The saved key is only reused for the
 * same provider at the same address: switching either needs the key typed
 * again, so a key is never sent somewhere it was not meant for.
 */
const candidate = (input: z.infer<typeof body>): AiSettings => {
  const saved = getSettings().ai;
  const baseUrl = input.provider === 'openai' ? input.baseUrl : '';
  const sameTarget =
    input.provider === saved.provider && baseUrl === saved.baseUrl;
  return {
    enabled: input.enabled,
    provider: input.provider,
    apiKey: input.removeApiKey
      ? ''
      : input.apiKey || (sameTarget ? saved.apiKey : ''),
    baseUrl,
    model: input.model,
    featureModels: input.featureModels,
    dailyLimit: input.dailyLimit,
  };
};

/** Claude and OpenAI itself need a key; a server at home may not. */
const missingKey = (ai: AiSettings) =>
  !ai.apiKey && (ai.provider === 'anthropic' || !ai.baseUrl)
    ? 'Enter the API key for this provider.'
    : undefined;

/** A tiny request: working means an answer came back, not just no error. */
const testConnection = async (ai: AiSettings, model = ai.model) => {
  const answer = await complete(ai, {
    model,
    system: 'Reply with the single word OK.',
    prompt: 'Ready?',
    maxTokens: 16,
  });
  if (!answer.text) {
    throw new Error(`${model} answered with nothing.`);
  }
};

const failed = (e: unknown) => ({
  status: 400,
  message: e instanceof Error ? e.message : 'The AI settings did not work.',
});

aiSettingsRoutes.get('/', (_req, res) => {
  res.status(200).json(visible(getSettings().ai));
});

aiSettingsRoutes.post('/', async (req, res, next) => {
  const parsed = body.safeParse(req.body);
  if (!parsed.success) {
    return next({ status: 400, message: parsed.error.issues[0]?.message });
  }
  const settings = getSettings();
  const next_ = candidate(parsed.data);
  const saved = settings.ai;

  // Checked with a tiny request before it is turned on or the connection
  // changes, so a typo cannot leave every AI button failing.
  const connectionChanged =
    next_.provider !== saved.provider ||
    next_.apiKey !== saved.apiKey ||
    next_.baseUrl !== saved.baseUrl ||
    next_.model !== saved.model ||
    (next_.enabled && !saved.enabled);
  if (next_.enabled) {
    if (!next_.model) {
      return next({ status: 400, message: 'Choose a model.' });
    }
    const noKey = missingKey(next_);
    if (noKey) {
      return next({ status: 400, message: noKey });
    }
    // The main model when the connection changes, and any feature's own
    // model that is new or changed.
    const toTest = new Set<string>(connectionChanged ? [next_.model] : []);
    for (const [feature, model] of Object.entries(next_.featureModels)) {
      if (
        model &&
        (connectionChanged ||
          model !== saved.featureModels?.[feature as AiFeature])
      ) {
        toTest.add(model);
      }
    }
    for (const model of toTest) {
      try {
        await testConnection(next_, model);
      } catch (e) {
        return next(failed(e));
      }
    }
  }

  // The balance, admin key and credit state belong to one account: another
  // provider, or another server, starts again.
  if (billedBy(next_) !== billedBy(saved)) {
    settings.aiCredit = {
      ...settings.aiCredit,
      adminKey: '',
      balance: null,
      balanceAt: null,
      outOfCreditAt: null,
    };
    forgetSpendReports();
  }
  settings.ai = next_;
  await settings.save();
  // Answers from a different model or provider are not reused.
  clearAiCache();
  logger.info('AI settings saved', {
    label: 'AI',
    enabled: next_.enabled,
    provider: next_.provider,
    model: next_.model,
  });
  return res.status(200).json(visible(next_));
});

/** A tiny request to the model: whether the key and model work. */
aiSettingsRoutes.post('/test', async (req, res, next) => {
  const parsed = body.safeParse(req.body);
  if (!parsed.success) {
    return next({ status: 400, message: parsed.error.issues[0]?.message });
  }
  const ai = candidate(parsed.data);
  const model =
    typeof req.body.testModel === 'string' && req.body.testModel.trim()
      ? req.body.testModel.trim()
      : ai.model;
  if (!model) {
    return next({ status: 400, message: 'Choose a model.' });
  }
  const noKey = missingKey(ai);
  if (noKey) {
    return next({ status: 400, message: noKey });
  }
  try {
    await testConnection(ai, model);
    // The saved account answered, so it has credit again.
    const saved = getSettings().ai;
    if (billedBy(ai) === billedBy(saved) && ai.apiKey === saved.apiKey) {
      clearOutOfCredit();
    }
    return res.status(200).json({ model });
  } catch (e) {
    return next(failed(e));
  }
});

/** The models this key can use, for the model picker. */
aiSettingsRoutes.post('/models', async (req, res, next) => {
  const parsed = body.safeParse(req.body);
  if (!parsed.success) {
    return next({ status: 400, message: parsed.error.issues[0]?.message });
  }
  const ai = candidate(parsed.data);
  const noKey = missingKey(ai);
  if (noKey) {
    return next({ status: 400, message: noKey });
  }
  try {
    return res.status(200).json(await listModels(ai));
  } catch (e) {
    return next(failed(e));
  }
});

// ---- credit -----------------------------------------------------------------

const creditBody = z.object({
  /** Empty keeps the saved one. */
  adminKey: z.string().trim().max(500).optional(),
  removeAdminKey: z.boolean().optional(),
  /** US dollars on the account now; null forgets the balance. */
  balance: z.number().min(0).max(1_000_000).nullable().optional(),
  /** US dollars per million tokens, by model. */
  prices: z
    .record(
      z.string().trim().min(1).max(200),
      z.object({
        input: z.number().min(0).max(10_000),
        output: z.number().min(0).max(10_000),
      })
    )
    .refine((prices) => Object.keys(prices).length <= 100, {
      message: 'Too many prices.',
    })
    .optional(),
});

/** What the AI account has spent and has left. */
aiSettingsRoutes.get('/credit', async (_req, res, next) => {
  try {
    return res.status(200).json(await creditReport());
  } catch (e) {
    return next({
      status: 500,
      message: e instanceof Error ? e.message : 'Could not work out credit.',
    });
  }
});

aiSettingsRoutes.post('/credit', async (req, res, next) => {
  const parsed = creditBody.safeParse(req.body);
  if (!parsed.success) {
    return next({ status: 400, message: parsed.error.issues[0]?.message });
  }
  const settings = getSettings();
  const provider = billedBy(settings.ai);
  if (!provider) {
    return next({
      status: 400,
      message: 'Only Claude and OpenAI itself bill for credit.',
    });
  }
  const input = parsed.data;
  const credit = { ...settings.aiCredit };

  if (input.removeAdminKey) {
    credit.adminKey = '';
  } else if (input.adminKey) {
    // Saved only once it has read the account's spending.
    try {
      await providerSpend(provider, input.adminKey, new Date());
    } catch (e) {
      return next(failed(e));
    }
    credit.adminKey = input.adminKey;
  }
  if (input.balance !== undefined) {
    credit.balance = input.balance;
    credit.balanceAt = input.balance === null ? null : new Date().toISOString();
  }
  if (input.prices) {
    credit.prices = input.prices;
  }

  settings.aiCredit = credit;
  await settings.save();
  forgetSpendReports();
  logger.info('AI credit settings saved', {
    label: 'AI',
    adminKey: !!credit.adminKey,
    balance: credit.balance !== null,
  });
  return res.status(200).json(await creditReport());
});

export default aiSettingsRoutes;
