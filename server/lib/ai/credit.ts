import { getRepository } from '@server/datasource';
import AiSpend from '@server/entity/AiSpend';
import { today } from '@server/lib/ai/day';
import type { Completion } from '@server/lib/ai/providers';
import {
  ANTHROPIC_URL,
  ANTHROPIC_VERSION,
  AiProviderError,
  OPENAI_URL,
  billedBy,
} from '@server/lib/ai/providers';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isUniqueViolation } from '@server/utils/isUniqueViolation';
import axios, { isAxiosError } from 'axios';
import { createHash } from 'node:crypto';
import { LessThan, MoreThanOrEqual } from 'typeorm';

/*
 * What the AI account has spent and has left.
 *
 * Neither OpenAI nor Anthropic exposes an account's balance, so it is the
 * balance an admin last entered less spend since. Spend comes from the
 * provider's cost report when an admin key is saved (the whole account, not
 * only Seerr), otherwise it is estimated from Seerr's own token counts at
 * the prices an admin entered per model.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Days of daily counts kept: a little over a year. */
const KEEP_DAYS = 400;

/** Each report is fetched at most this often. */
const REPORT_TTL_MS = 10 * 60 * 1000;
const REPORT_TIMEOUT_MS = 15_000;

/** A month of daily buckets per page; a year at most. */
const PAGE_DAYS = 31;
const MAX_PAGES = 13;

// ---- Seerr's own requests ---------------------------------------------------

/** Adds one answer's tokens to today's count for its model. */
export const recordSpend = async (
  model: string,
  inputTokens: number,
  outputTokens: number
): Promise<void> => {
  const repository = getRepository(AiSpend);
  const where = { day: today(), model: model.slice(0, 200) };

  try {
    await repository.insert({
      ...where,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    // The day's first answer also deletes rows older than KEEP_DAYS.
    await repository.delete({
      day: LessThan(today(new Date(Date.now() - KEEP_DAYS * DAY_MS))),
    });
  } catch (e) {
    if (!isUniqueViolation(e)) {
      throw e;
    }
  }

  await repository
    .createQueryBuilder()
    .update(AiSpend)
    .set({
      requests: () => 'requests + 1',
      inputTokens: () => '"inputTokens" + :input',
      outputTokens: () => '"outputTokens" + :output',
    })
    .where('day = :day AND model = :model', where)
    .setParameters({
      input: Math.max(0, Math.round(inputTokens)),
      output: Math.max(0, Math.round(outputTokens)),
    })
    .execute();
};

const saveSettings = () =>
  getSettings()
    .save()
    .catch((e) =>
      logger.error('Could not save the AI credit state', {
        label: 'AI',
        errorMessage: e instanceof Error ? e.message : String(e),
      })
    );

/**
 * Counts an answer and clears the out-of-credit mark. Resolves once the
 * count is written, for callers that wait (the admin agent); a failed write
 * is only logged.
 */
export const countAnswer = async (
  model: string,
  answer: Completion
): Promise<void> => {
  clearOutOfCredit();
  try {
    await recordSpend(model, answer.inputTokens, answer.outputTokens);
  } catch (e) {
    logger.warn('Could not count an AI answer', {
      label: 'AI',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
  }
};

/** Counts an answer in the background. */
export const noteAnswer = (model: string, answer: Completion) => {
  void countAnswer(model, answer);
};

export const clearOutOfCredit = () => {
  const credit = getSettings().aiCredit;
  if (credit.outOfCreditAt) {
    credit.outOfCreditAt = null;
    saveSettings();
    logger.info('The AI account answered again', { label: 'AI' });
  }
};

/** Marks the account out of credit if that is why a request failed. */
export const noteFailure = (e: unknown) => {
  if (!(e instanceof AiProviderError) || !e.outOfCredit) {
    return;
  }
  const credit = getSettings().aiCredit;
  if (!credit.outOfCreditAt) {
    credit.outOfCreditAt = new Date().toISOString();
    saveSettings();
    logger.warn('The AI account is out of credit', { label: 'AI' });
  }
};

// ---- the provider's own report ----------------------------------------------

interface OpenAiCosts {
  data?: { results?: { amount?: { value?: number } }[] }[];
  has_more?: boolean;
  next_page?: string | null;
}

interface AnthropicCosts {
  data?: { results?: { amount?: string }[] }[];
  has_more?: boolean;
  next_page?: string | null;
}

interface AnthropicCostRows {
  data?: { cost?: { amount?: string } }[];
  has_more?: boolean;
  next_page?: string | null;
}

/** The beta that Anthropic's cost analytics needs on every request. */
const ANTHROPIC_ANALYTICS_BETA = 'analytics-usage-cost-2026-08-24';
/** Cost analytics has nothing before this. */
const ANALYTICS_FIRST_DAY = Date.UTC(2026, 0, 1);
const ANALYTICS_LOOKBACK_DAYS = 365;

const openAiSpend = async (adminKey: string, since: Date) => {
  let total = 0;
  let page: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const { data } = await axios.get<OpenAiCosts>(
      `${OPENAI_URL}/organization/costs`,
      {
        headers: { authorization: `Bearer ${adminKey}` },
        params: {
          start_time: Math.floor(since.getTime() / 1000),
          end_time: Math.ceil(Date.now() / 1000),
          bucket_width: '1d',
          limit: PAGE_DAYS,
          ...(page ? { page } : {}),
        },
        timeout: REPORT_TIMEOUT_MS,
      }
    );
    for (const bucket of data.data ?? []) {
      for (const result of bucket.results ?? []) {
        total += Number(result.amount?.value) || 0;
      }
    }
    if (!data.has_more || !data.next_page) {
      break;
    }
    page = data.next_page;
  }
  return total;
};

const anthropicHeaders = (adminKey: string, beta?: string) => ({
  'x-api-key': adminKey,
  'anthropic-version': ANTHROPIC_VERSION,
  ...(beta ? { 'anthropic-beta': beta } : {}),
});

/** Legacy daily cost report: whole UTC days, never today. */
const anthropicCostReport = async (
  adminKey: string,
  since: Date,
  until?: Date
) => {
  let total = 0;
  let page: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const { data } = await axios.get<AnthropicCosts>(
      `${ANTHROPIC_URL}/organizations/cost_report`,
      {
        headers: anthropicHeaders(adminKey),
        params: {
          starting_at: since.toISOString(),
          ...(until ? { ending_at: until.toISOString() } : {}),
          bucket_width: '1d',
          limit: PAGE_DAYS,
          ...(page ? { page } : {}),
        },
        timeout: REPORT_TIMEOUT_MS,
      }
    );
    for (const bucket of data.data ?? []) {
      for (const result of bucket.results ?? []) {
        // A decimal string in cents: "123.45" is $1.23.
        total += (Number(result.amount) || 0) / 100;
      }
    }
    if (!data.has_more || !data.next_page) {
      break;
    }
    page = data.next_page;
  }
  return total;
};

/** Cost analytics for one stretch of at most 31 days, as one total. */
const anthropicAnalyticsWindow = async (
  adminKey: string,
  from: Date,
  to: Date
) => {
  let total = 0;
  let page: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const { data } = await axios.get<AnthropicCostRows>(
      `${ANTHROPIC_URL}/organizations/analytics/cost`,
      {
        headers: anthropicHeaders(adminKey, ANTHROPIC_ANALYTICS_BETA),
        // No bucket width and no grouping: one row for the whole stretch.
        params: {
          starting_at: from.toISOString(),
          ending_at: to.toISOString(),
          limit: 1000,
          ...(page ? { page } : {}),
        },
        timeout: REPORT_TIMEOUT_MS,
      }
    );
    for (const row of data.data ?? []) {
      // Cents with six decimals: "41280.000000" is $412.80.
      total += (Number(row.cost?.amount) || 0) / 100;
    }
    if (!data.has_more || !data.next_page) {
      break;
    }
    page = data.next_page;
  }
  return total;
};

/**
 * Whether cost analytics is unavailable here, so the legacy report is
 * used instead: not found, not allowed, or an error saying so.
 */
const analyticsUnavailable = (e: unknown) => {
  if (!isAxiosError(e) || !e.response) {
    return false;
  }
  const status = e.response.status;
  if (status === 403 || status === 404) {
    return true;
  }
  const message =
    (e.response.data as { error?: { message?: string } } | undefined)?.error
      ?.message ?? '';
  return status >= 400 && status < 500 && /not (yet )?available/i.test(message);
};

/**
 * Cost analytics from `since` to `until`, in stretches of 31 days. Unlike
 * the legacy report it includes today, as far as Anthropic has counted it
 * (usually within 4 hours).
 */
const anthropicAnalytics = async (
  adminKey: string,
  since: Date,
  until: Date
) => {
  let total = 0;
  let asked = false;
  for (
    let from = since.getTime(), i = 0;
    from < until.getTime() && i < MAX_PAGES;
    from += PAGE_DAYS * DAY_MS, i++
  ) {
    const to = Math.min(from + PAGE_DAYS * DAY_MS, until.getTime());
    // Both ends round down to the hour: less than an hour is nothing yet.
    if (to - from < HOUR_MS) {
      continue;
    }
    total += await anthropicAnalyticsWindow(
      adminKey,
      new Date(from),
      new Date(to)
    );
    asked = true;
  }
  if (!asked) {
    // Within the day's first hour there is nothing to count yet, but the key
    // and the endpoint are still checked, on the hour before.
    await anthropicAnalyticsWindow(
      adminKey,
      new Date(since.getTime() - HOUR_MS),
      since
    );
  }
  return total;
};

/**
 * The account's spend from `since`. Cost analytics covers the last 365
 * days and nothing before 2026, so anything older comes from the legacy
 * cost report, as does everything where cost analytics isn't available.
 */
const anthropicSpend = async (adminKey: string, since: Date, until: Date) => {
  const floor = Math.max(
    ANALYTICS_FIRST_DAY,
    Math.ceil((until.getTime() - ANALYTICS_LOOKBACK_DAYS * DAY_MS) / DAY_MS) *
      DAY_MS
  );
  const from = new Date(Math.max(since.getTime(), floor));
  let recent: number;
  try {
    recent = await anthropicAnalytics(adminKey, from, until);
  } catch (e) {
    if (!analyticsUnavailable(e)) {
      throw e;
    }
    logger.debug('Anthropic cost analytics unavailable; using cost_report', {
      label: 'AI',
      status: isAxiosError(e) ? e.response?.status : undefined,
    });
    return anthropicCostReport(adminKey, since);
  }
  const older =
    since.getTime() < from.getTime()
      ? await anthropicCostReport(adminKey, since, from)
      : 0;
  return older + recent;
};

/** A failed report, explained so an admin can act on it. */
const explainReport = (
  e: unknown,
  provider: 'anthropic' | 'openai',
  adminKey: string
) => {
  const name = provider === 'anthropic' ? 'Anthropic' : 'OpenAI';
  if (!isAxiosError(e)) {
    return `${name}'s spending report could not be read.`;
  }
  const status = e.response?.status;
  if (status === 401) {
    return `${name} rejected the admin key.`;
  }
  if (status === 403 || status === 404) {
    return provider === 'anthropic'
      ? 'This key cannot read spending. It needs to be an Admin API key (sk-ant-admin…), which Anthropic only gives to organization accounts.'
      : 'This key cannot read spending. It needs to be an admin key (sk-admin…), made by the organization owner.';
  }
  if (!e.response) {
    return `Could not reach ${name}.`;
  }
  const data = e.response.data as { error?: { message?: string } } | undefined;
  const detail = (data?.error?.message ?? '')
    .split(adminKey)
    .join('[key]')
    .slice(0, 200);
  return `${name}'s spending report failed${detail ? `: ${detail}` : '.'}`;
};

const reports = new Map<string, { until: number; spent: number }>();

/**
 * The whole account's spend since the start of the UTC day holding `since`;
 * both reports count whole days.
 */
export const providerSpend = async (
  provider: 'anthropic' | 'openai',
  adminKey: string,
  since: Date,
  until = new Date()
): Promise<number> => {
  const from = new Date(
    Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate())
  );
  const key = createHash('sha256')
    .update(`${provider}:${adminKey}:${from.toISOString()}`)
    .digest('base64url');
  const hit = reports.get(key);
  if (hit && hit.until > Date.now()) {
    return hit.spent;
  }
  try {
    const spent =
      provider === 'anthropic'
        ? await anthropicSpend(adminKey, from, until)
        : await openAiSpend(adminKey, from);
    reports.set(key, { until: Date.now() + REPORT_TTL_MS, spent });
    return spent;
  } catch (e) {
    throw new Error(explainReport(e, provider, adminKey));
  }
};

/** Clears cached reports, as when the key or balance changes. */
export const forgetSpendReports = () => reports.clear();

// ---- the report shown in settings -------------------------------------------

export interface ModelSpend {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Null without a price for the model. */
  cost: number | null;
}

export interface CreditReport {
  /** Who bills for the AI settings; null for a server that doesn't bill. */
  billedBy: 'anthropic' | 'openai' | null;
  outOfCreditAt: string | null;
  hasAdminKey: boolean;
  balance: number | null;
  balanceAt: string | null;
  source: 'provider' | 'estimate';
  /** Why the provider's report was not used, when an admin key is saved. */
  providerProblem?: string;
  /** The first day of this month, YYYY-MM-DD. */
  monthStart: string;
  spentThisMonth: number;
  spentSinceBalance: number | null;
  remaining: number | null;
  /** Models used without a price, left out of an estimate. */
  unpriced: string[];
  /** Seerr's own requests this month, by model. */
  models: ModelSpend[];
  prices: Record<string, { input: number; output: number }>;
}

const costOf = (
  row: { inputTokens: number; outputTokens: number },
  price?: { input: number; output: number }
) =>
  price
    ? (row.inputTokens * price.input + row.outputTokens * price.output) /
      1_000_000
    : null;

/** Seerr's own requests since a day, by model. */
const ownSpend = async (sinceDay: string) => {
  const rows = await getRepository(AiSpend).find({
    where: { day: MoreThanOrEqual(sinceDay) },
  });
  const byModel = new Map<string, Omit<ModelSpend, 'cost'>>();
  for (const row of rows) {
    const sum = byModel.get(row.model) ?? {
      model: row.model,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    sum.requests += row.requests;
    sum.inputTokens += row.inputTokens;
    sum.outputTokens += row.outputTokens;
    byModel.set(row.model, sum);
  }
  const prices = getSettings().aiCredit.prices;
  const models = [...byModel.values()].map((m) => ({
    ...m,
    cost: costOf(m, prices[m.model]),
  }));
  return {
    models,
    spent: models.reduce((total, m) => total + (m.cost ?? 0), 0),
    unpriced: models.filter((m) => m.cost === null).map((m) => m.model),
  };
};

export const creditReport = async (now = new Date()): Promise<CreditReport> => {
  const settings = getSettings();
  const ai = settings.ai;
  const credit = settings.aiCredit;
  const provider = billedBy(ai);

  // This month by the server's clock, like Seerr's own counts. The
  // provider's report counts whole UTC days, so it starts from the 1st in
  // UTC: east of UTC, local midnight on the 1st is still the previous
  // month's last day in UTC, and that whole day would be counted.
  const monthStart = today(new Date(now.getFullYear(), now.getMonth(), 1));
  const providerMonthStart = new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), 1)
  );
  const balanceAt = credit.balanceAt ? new Date(credit.balanceAt) : null;

  const month = await ownSpend(monthStart);
  const sinceBalance = balanceAt ? await ownSpend(today(balanceAt)) : null;

  // This month's models plus configured unused ones, so a price can be
  // entered before it is needed.
  const configured = [ai.model, ...Object.values(ai.featureModels ?? {})]
    .map((m) => m?.trim())
    .filter((m): m is string => !!m);
  const models = [...month.models];
  for (const model of configured) {
    if (!models.some((m) => m.model === model)) {
      models.push({
        model,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: costOf({ inputTokens: 0, outputTokens: 0 }, credit.prices[model]),
      });
    }
  }
  models.sort(
    (a, b) => b.requests - a.requests || a.model.localeCompare(b.model)
  );

  let source: CreditReport['source'] = 'estimate';
  let spentThisMonth = month.spent;
  let spentSinceBalance = sinceBalance?.spent ?? null;
  let providerProblem: string | undefined;
  let unpriced = [
    ...new Set([...month.unpriced, ...(sinceBalance?.unpriced ?? [])]),
  ];

  if (provider && credit.adminKey) {
    try {
      const [thisMonth, since] = await Promise.all([
        // Early in the local month, east of UTC, the UTC month hasn't begun:
        // nothing is spent in it yet.
        providerMonthStart > now
          ? Promise.resolve(0)
          : providerSpend(provider, credit.adminKey, providerMonthStart, now),
        balanceAt
          ? providerSpend(provider, credit.adminKey, balanceAt, now)
          : Promise.resolve(null),
      ]);
      source = 'provider';
      spentThisMonth = thisMonth;
      spentSinceBalance = since;
      unpriced = [];
    } catch (e) {
      providerProblem = e instanceof Error ? e.message : String(e);
    }
  }

  return {
    billedBy: provider,
    outOfCreditAt: credit.outOfCreditAt,
    hasAdminKey: !!credit.adminKey,
    balance: credit.balance,
    balanceAt: credit.balanceAt,
    source,
    ...(providerProblem ? { providerProblem } : {}),
    monthStart,
    spentThisMonth,
    spentSinceBalance,
    remaining:
      credit.balance !== null && spentSinceBalance !== null
        ? credit.balance - spentSinceBalance
        : null,
    unpriced,
    models,
    prices: credit.prices,
  };
};
