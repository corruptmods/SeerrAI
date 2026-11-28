import type { AiEffort } from '@server/constants/features';
import type { AiSettings } from '@server/lib/settings';
import axios, { isAxiosError } from 'axios';

/*
 * The two model APIs, each sent the smallest request it accepts: one system
 * prompt, one user message, an answer cap and the least thinking allowed.
 * No temperature or sampling settings, which newer models reject.
 *
 * Newer models on both APIs think before answering; thinking is billed and
 * counts against the cap. Each request asks for the effort set for its
 * feature ("lowest" by default: the least the model accepts) and leaves
 * room for it. A model's accepted level is learned from its first refusal
 * and remembered per requested effort: a few retries at most per model and
 * effort per restart.
 */

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1';
export const OPENAI_URL = 'https://api.openai.com/v1';
/**
 * The Claude API version sent on every Anthropic request, spend reports
 * included. 2026-10-21 rejects sampling settings, documents in assistant
 * turns and citations in user turns; none is ever sent here.
 */
export const ANTHROPIC_VERSION = '2026-10-21';

/**
 * Long enough for a slow model writing a few hundred words; more for the
 * higher efforts, which think for longer first.
 */
const COMPLETION_TIMEOUT_MS: Record<AiEffort, number> = {
  none: 90_000,
  lowest: 90_000,
  low: 90_000,
  medium: 120_000,
  high: 180_000,
};
const LIST_TIMEOUT_MS = 15_000;

/**
 * Room for thinking on top of the answer's cap, by effort. Only what is
 * used is billed; without it a thinking model can spend the cap and say
 * nothing.
 */
const THINKING_ROOM: Record<AiEffort, number> = {
  none: 2048,
  lowest: 2048,
  low: 2048,
  medium: 8192,
  high: 16384,
};

/** Image types both APIs accept. */
export const IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

/** An image sent with the message, as base64. */
export interface CompletionImage {
  type: ImageType;
  data: string;
}

export interface CompletionRequest {
  model: string;
  system: string;
  prompt: string;
  /** An image for the model to read with the prompt. */
  image?: CompletionImage;
  /** Max tokens the answer itself needs; set per feature. */
  maxTokens: number;
  /** Ask for a JSON object where the API can enforce it. */
  json?: boolean;
  /** How hard the model thinks; "lowest" if unset. */
  effort?: AiEffort;
}

export interface Completion {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ModelInfo {
  id: string;
  name: string;
}

/** An error the admin or user can act on. */
export class AiProviderError extends Error {
  constructor(
    message: string,
    public readonly status = 502,
    /** The provider said the account has no credit left. */
    public readonly outOfCredit = false,
    /**
     * Lets the page translate it, like AiError's code; omitted when the
     * message carries the provider's own details.
     */
    public readonly code?: string
  ) {
    super(message);
  }
}

const openAiBase = (ai: AiSettings) =>
  (ai.baseUrl.trim() || OPENAI_URL).replace(/\/+$/, '');

const isOfficialOpenAi = (ai: AiSettings) =>
  ai.provider === 'openai' && openAiBase(ai) === OPENAI_URL;

/**
 * The provider billing for these settings, or null for any other server
 * (self-hosted, or another OpenAI-compatible service).
 */
export const billedBy = (ai: AiSettings): 'anthropic' | 'openai' | null =>
  ai.provider === 'anthropic'
    ? 'anthropic'
    : isOfficialOpenAi(ai)
      ? 'openai'
      : null;

/**
 * Whether an OpenAI model reasons: all but GPT-4, GPT-3.5 and chatgpt-*.
 * Reasoning models get the effort set for the feature.
 */
export const isReasoningModel = (model: string) =>
  !/^(gpt-4|gpt-3\.5|chatgpt-)/i.test(model.trim());

/** OpenAI's efforts, lowest first. */
const OPENAI_LEVELS = ['none', 'minimal', 'low', 'medium', 'high'];

/**
 * The OpenAI efforts to try for a setting, in order; a model that refuses
 * one is retried with the next, and null sends none. "lowest" is cheapest
 * first; any other setting is that level, then the levels below it.
 */
const openAiLadder = (effort: AiEffort): (string | null)[] =>
  effort === 'lowest' || effort === 'none'
    ? ['none', 'minimal', 'low', null]
    : [
        ...OPENAI_LEVELS.slice(0, OPENAI_LEVELS.indexOf(effort) + 1).reverse(),
        null,
      ];

/** Claude's effort for a setting: it has no level below "low", so "none" is "low". */
const claudeLevel = (effort: AiEffort) =>
  effort === 'medium' || effort === 'high' ? effort : 'low';

/**
 * What each model accepted for each requested effort, for the process
 * lifetime: an OpenAI effort (null to send none), and whether Claude takes
 * an effort at all. Keyed by model and effort, so asking for another effort
 * is tried afresh.
 */
const openAiEffort = new Map<string, string | null>();
const claudeEffort = new Map<string, boolean>();
const memoKey = (...parts: string[]) => parts.join('|');

export const resetProviderMemoryForTests = () => {
  openAiEffort.clear();
  claudeEffort.clear();
};

/** The provider's own words about a failed request, if it gave any. */
const detailOf = (e: unknown): string => {
  if (!isAxiosError(e)) {
    return '';
  }
  const data = e.response?.data as
    | { error?: { message?: string } | string; message?: string }
    | undefined;
  return (
    (typeof data?.error === 'object' ? data.error?.message : data?.error) ??
    data?.message ??
    ''
  );
};

/**
 * Whether a failure means the account has run out of credit: OpenAI's
 * insufficient_quota ("You exceeded your current quota"), and Anthropic's
 * billing error or "Your credit balance is too low".
 */
const isOutOfCredit = (e: unknown) => {
  if (!isAxiosError(e)) {
    return false;
  }
  const error = (
    e.response?.data as { error?: { type?: string; code?: string } } | undefined
  )?.error;
  const kind = `${error?.type ?? ''} ${error?.code ?? ''}`.toLowerCase();
  const detail = detailOf(e).toLowerCase();
  return (
    e.response?.status === 402 ||
    kind.includes('insufficient_quota') ||
    kind.includes('billing') ||
    detail.includes('credit balance is too low') ||
    detail.includes('exceeded your current quota')
  );
};

/** A 400 that names one of the optional settings. */
const refused = (e: unknown, ...names: string[]) =>
  isAxiosError(e) &&
  e.response?.status === 400 &&
  names.some((name) => detailOf(e).toLowerCase().includes(name));

/**
 * A refusal of the image itself, which text-only models and servers without
 * image support word in many ways.
 */
const refusedPicture = (e: unknown) =>
  isAxiosError(e) &&
  (e.response?.status === 400 || e.response?.status === 422) &&
  /image|vision|multimodal|picture|content.*(type|part|array)|unsupported.*content/i.test(
    detailOf(e)
  );

/** Turns an API failure into a sentence someone can act on. */
const explain = (
  e: unknown,
  provider: string,
  apiKey: string,
  withImage = false
): AiProviderError => {
  // The key never goes further, whatever the server echoes back.
  const scrub = (text: string) =>
    apiKey ? text.split(apiKey).join('[key]') : text;
  if (!isAxiosError(e)) {
    return new AiProviderError(
      scrub(e instanceof Error ? e.message : `${provider} failed.`)
    );
  }
  if (e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT') {
    return new AiProviderError(
      `${provider} took too long to answer.`,
      504,
      false,
      'timeout'
    );
  }
  const status = e.response?.status;
  const detail = scrub(detailOf(e)).slice(0, 300);
  if (withImage && refusedPicture(e)) {
    return new AiProviderError(
      'The AI model in use cannot read pictures. An admin can choose one that can in the AI settings.',
      400,
      false,
      'noPictures'
    );
  }
  if (isOutOfCredit(e)) {
    return new AiProviderError(
      `${
        provider === 'Claude'
          ? 'The Anthropic account'
          : provider === 'OpenAI'
            ? 'The OpenAI account'
            : 'The AI service account'
      } is out of credit. AI features work again once more is added.`,
      503,
      true,
      'outOfCredit'
    );
  }
  if (status === 401) {
    return new AiProviderError(`${provider} rejected the API key.`);
  }
  if (status === 403) {
    return new AiProviderError(
      `${provider} does not allow this key to do that${detail ? `: ${detail}` : '.'}`
    );
  }
  if (status === 404) {
    return new AiProviderError(
      `${provider} does not know that model${detail ? `: ${detail}` : '.'}`
    );
  }
  if (status === 429) {
    return new AiProviderError(
      `${provider} is limiting requests. Try again shortly.`,
      503,
      false,
      'busy'
    );
  }
  if (status && status >= 500) {
    return new AiProviderError(
      `${provider} is having trouble right now. Try again shortly.`,
      503,
      false,
      'busy'
    );
  }
  if (!e.response) {
    return new AiProviderError(
      `Could not reach ${provider}.`,
      502,
      false,
      'unreachable'
    );
  }
  return new AiProviderError(
    `${provider} refused the request${detail ? `: ${detail}` : '.'}`
  );
};

const anthropicHeaders = (ai: AiSettings) => ({
  'x-api-key': ai.apiKey,
  'anthropic-version': ANTHROPIC_VERSION,
  'content-type': 'application/json',
});

const openAiHeaders = (ai: AiSettings) => ({
  'content-type': 'application/json',
  // A local server may need no key at all.
  ...(ai.apiKey ? { authorization: `Bearer ${ai.apiKey}` } : {}),
});

const RAN_OUT =
  'used up its answer length thinking before it replied. Try again, or choose a model that thinks less.';

/** Claude's safety checks stopped the answer: never shown as an empty one. */
const DECLINED = 'Claude declined to answer this. Try asking another way.';

/**
 * Sends a Claude request with an effort, or without one for older models
 * that have no effort setting and say so.
 */
const withClaudeEffort = async <T>(
  model: string,
  effort: AiEffort,
  send: (level: string | null) => Promise<T>
): Promise<T> => {
  const level = claudeLevel(effort);
  const key = memoKey(model, level);
  const known = claudeEffort.get(key);
  try {
    const response = await send(known !== false ? level : null);
    claudeEffort.set(key, known !== false);
    return response;
  } catch (e) {
    if (known === undefined && refused(e, 'effort', 'output_config')) {
      claudeEffort.set(key, false);
      return send(null);
    }
    throw e;
  }
};

/**
 * The OpenAI efforts to try for a request, and where to remember the one
 * accepted (none when there is nothing to remember).
 */
const openAiPlan = (
  ai: AiSettings,
  model: string,
  effort: AiEffort,
  withTools = false
): { efforts: (string | null)[]; key?: string } => {
  // With tools a model can refuse an effort it takes without them (as
  // OpenAI's newer models do on chat completions, and other servers may),
  // so the two are remembered apart.
  const tools = withTools ? 'tools' : 'plain';
  // What was remembered goes first; if it is refused after all, the rest of
  // the ladder below it is tried rather than failing.
  const after = (
    ladder: (string | null)[],
    known: string | null | undefined
  ) =>
    known === undefined || !ladder.includes(known)
      ? ladder
      : [known, ...ladder.slice(ladder.indexOf(known) + 1)];
  if (isOfficialOpenAi(ai)) {
    if (!isReasoningModel(model)) {
      return { efforts: [null] };
    }
    const key = memoKey(model, effort, tools);
    return { efforts: after(openAiLadder(effort), openAiEffort.get(key)), key };
  }
  // Another server gets an effort only when one was chosen, dropped if it
  // refuses it.
  if (effort === 'lowest') {
    return { efforts: [null] };
  }
  const key = memoKey(openAiBase(ai), model, effort, tools);
  return { efforts: after([effort, null], openAiEffort.get(key)), key };
};

/**
 * Claude's room for thinking: by effort when one is sent; the least when
 * the model takes no effort.
 */
const claudeRoom = (effort: AiEffort, level: string | null) =>
  THINKING_ROOM[level ? effort : 'lowest'];

const completeAnthropic = async (
  ai: AiSettings,
  req: CompletionRequest
): Promise<Completion> => {
  const effort = req.effort ?? 'lowest';
  const send = (level: string | null) =>
    axios.post<{
      content: { type: string; text?: string }[];
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    }>(
      `${ANTHROPIC_URL}/messages`,
      {
        model: req.model,
        max_tokens: req.maxTokens + claudeRoom(effort, level),
        system: req.system,
        messages: [
          {
            role: 'user',
            content: req.image
              ? [
                  {
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: req.image.type,
                      data: req.image.data,
                    },
                  },
                  { type: 'text', text: req.prompt },
                ]
              : req.prompt,
          },
        ],
        ...(level ? { output_config: { effort: level } } : {}),
      },
      { headers: anthropicHeaders(ai), timeout: COMPLETION_TIMEOUT_MS[effort] }
    );

  let response;
  try {
    response = await withClaudeEffort(req.model, effort, send);
  } catch (e) {
    throw explain(e, 'Claude', ai.apiKey, !!req.image);
  }

  const { data } = response;
  const text = data.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
    .trim();
  if (data.stop_reason === 'refusal') {
    throw new AiProviderError(DECLINED);
  }
  if (!text && data.stop_reason === 'max_tokens') {
    throw new AiProviderError(`Claude ${RAN_OUT}`);
  }
  return {
    text,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
  };
};

/**
 * Tries each effort in turn until one is accepted, remembering it under
 * `key`. A refused JSON mode is dropped; a refused effort steps down; any
 * other failure is thrown as it is.
 */
const withOpenAiEffort = async <T>(
  { efforts, key }: { efforts: (string | null)[]; key?: string },
  send: (effort: string | null, json: boolean) => Promise<T>,
  { json = false, refusals }: { json?: boolean; refusals: string[] }
): Promise<T> => {
  let lastError: unknown;
  for (let i = 0; i < efforts.length; ) {
    try {
      const data = await send(efforts[i], json);
      if (key) {
        openAiEffort.set(key, efforts[i]);
      }
      return data;
    } catch (e) {
      lastError = e;
      if (json && refused(e, 'response_format', 'text.format', 'json_object')) {
        json = false;
      } else if (efforts[i] && refused(e, ...refusals)) {
        i += 1;
      } else {
        break;
      }
    }
  }
  throw lastError;
};

/*
 * OpenAI itself is sent the Responses API (/responses), the only one on
 * which its newer models take tools and an effort together. Nothing is
 * stored there (store: false): each request carries the whole conversation.
 */

/** An item of a Responses reply: a message, a function call or reasoning. */
interface ResponsesItem {
  type?: string;
  content?: unknown;
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface ResponsesReply {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: ResponsesItem[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

const postResponses = async (
  ai: AiSettings,
  body: Record<string, unknown>,
  effort: AiEffort
) =>
  (
    await axios.post<ResponsesReply>(`${OPENAI_URL}/responses`, body, {
      headers: openAiHeaders(ai),
      timeout: COMPLETION_TIMEOUT_MS[effort],
    })
  ).data;

/** The reply's text: every output_text part of its messages. */
const responsesText = (data: ResponsesReply) =>
  (data.output ?? [])
    .filter((item) => item.type === 'message' && Array.isArray(item.content))
    .flatMap((item) => item.content as { type?: string; text?: string }[])
    .filter((part) => part?.type === 'output_text')
    .map((part) => part.text ?? '')
    .join('')
    .trim();

/** Whether the reply stopped at its cap. */
const responsesCutOff = (data: ResponsesReply) =>
  data.status === 'incomplete' &&
  data.incomplete_details?.reason === 'max_output_tokens';

const responsesUsage = (data: ResponsesReply) => ({
  inputTokens: data.usage?.input_tokens ?? 0,
  outputTokens: data.usage?.output_tokens ?? 0,
});

/** A Responses request's cap, with room to think, and its effort. */
const responsesLimits = (
  model: string,
  maxTokens: number,
  effortSetting: AiEffort,
  effort: string | null
) => ({
  max_output_tokens: isReasoningModel(model)
    ? maxTokens + THINKING_ROOM[effortSetting]
    : maxTokens,
  ...(effort ? { reasoning: { effort } } : {}),
});

const completeResponses = async (
  ai: AiSettings,
  req: CompletionRequest
): Promise<Completion> => {
  const effortSetting = req.effort ?? 'lowest';
  // An image goes as a data URL after the text.
  const content = [
    { type: 'input_text', text: req.prompt },
    ...(req.image
      ? [
          {
            type: 'input_image',
            image_url: `data:${req.image.type};base64,${req.image.data}`,
            detail: 'auto',
          },
        ]
      : []),
  ];
  const send = (effort: string | null, json: boolean) =>
    postResponses(
      ai,
      {
        model: req.model,
        instructions: req.system,
        input: [{ role: 'user', content }],
        ...responsesLimits(req.model, req.maxTokens, effortSetting, effort),
        ...(json ? { text: { format: { type: 'json_object' } } } : {}),
        store: false,
      },
      effortSetting
    );

  let data: ResponsesReply;
  try {
    data = await withOpenAiEffort(
      openAiPlan(ai, req.model, effortSetting),
      send,
      { json: !!req.json, refusals: ['reasoning_effort', 'reasoning'] }
    );
  } catch (e) {
    throw explain(e, 'OpenAI', ai.apiKey, !!req.image);
  }

  const text = responsesText(data);
  if (!text && responsesCutOff(data)) {
    throw new AiProviderError(`OpenAI ${RAN_OUT}`);
  }
  return { text, ...responsesUsage(data) };
};

interface OpenAiResponse {
  choices?: {
    message?: { content?: string | null };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * OpenAI itself gets the Responses API. Any other OpenAI-compatible server
 * (Ollama, LM Studio, vLLM, OpenRouter), many of which have no /responses,
 * gets chat completions in the older form every one of them understands,
 * with an effort only when one was chosen.
 */
const completeOpenAi = async (
  ai: AiSettings,
  req: CompletionRequest
): Promise<Completion> => {
  if (isOfficialOpenAi(ai)) {
    return completeResponses(ai, req);
  }
  const name = 'The AI server';
  const effortSetting = req.effort ?? 'lowest';
  const room = THINKING_ROOM[effortSetting];

  // An image goes as a data URL beside the text, which OpenAI's imitators
  // (Ollama, LM Studio, vLLM) all accept.
  const user = req.image
    ? [
        { type: 'text', text: req.prompt },
        {
          type: 'image_url',
          image_url: { url: `data:${req.image.type};base64,${req.image.data}` },
        },
      ]
    : req.prompt;

  const send = async (effort: string | null) =>
    (
      await axios.post<OpenAiResponse>(
        `${openAiBase(ai)}/chat/completions`,
        {
          model: req.model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: user },
          ],
          max_tokens: effort ? req.maxTokens + room : req.maxTokens,
          ...(effort ? { reasoning_effort: effort } : {}),
        },
        {
          headers: openAiHeaders(ai),
          timeout: COMPLETION_TIMEOUT_MS[effortSetting],
        }
      )
    ).data;

  let data: OpenAiResponse;
  try {
    data = await withOpenAiEffort(
      openAiPlan(ai, req.model, effortSetting),
      send,
      { refusals: ['reasoning_effort', 'reasoning'] }
    );
  } catch (e) {
    throw explain(e, name, ai.apiKey, !!req.image);
  }

  const choice = data.choices?.[0];
  const text = (choice?.message?.content ?? '').trim();
  if (!text && choice?.finish_reason === 'length') {
    throw new AiProviderError(`${name} ${RAN_OUT}`);
  }
  return {
    text,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };
};

export const complete = (
  ai: AiSettings,
  req: CompletionRequest
): Promise<Completion> =>
  ai.provider === 'anthropic'
    ? completeAnthropic(ai, req)
    : completeOpenAi(ai, req);

/**
 * Filters out OpenAI models this cannot use: speech, images, embeddings,
 * ones made for other tools (coding, computer use, deep research), and the
 * far dearer -pro models.
 */
const OPENAI_CHAT = /^(gpt-|o\d|chatgpt-)/i;
const OPENAI_NOT_CHAT =
  /(audio|realtime|tts|transcribe|search|image|embedding|instruct|moderation|codex|computer-use|dall-e|whisper|deep-research|-pro\b|\blive\b)/i;

/** Every model this key can use, newest first where the API says. */
export const listModels = async (ai: AiSettings): Promise<ModelInfo[]> => {
  if (ai.provider === 'anthropic') {
    try {
      const { data } = await axios.get<{
        data: { id: string; display_name?: string }[];
      }>(`${ANTHROPIC_URL}/models`, {
        headers: anthropicHeaders(ai),
        params: { limit: 1000 },
        timeout: LIST_TIMEOUT_MS,
      });
      return data.data.map((m) => ({ id: m.id, name: m.display_name ?? m.id }));
    } catch (e) {
      throw explain(e, 'Claude', ai.apiKey);
    }
  }

  const official = isOfficialOpenAi(ai);
  try {
    const { data } = await axios.get<{
      data: { id: string; created?: number }[];
    }>(`${openAiBase(ai)}/models`, {
      headers: openAiHeaders(ai),
      timeout: LIST_TIMEOUT_MS,
    });
    return data.data
      .filter(
        (m) =>
          !official || (OPENAI_CHAT.test(m.id) && !OPENAI_NOT_CHAT.test(m.id))
      )
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
      .map((m) => ({ id: m.id, name: m.id }));
  } catch (e) {
    throw explain(e, official ? 'OpenAI' : 'The AI server', ai.apiKey);
  }
};

// ---- A conversation with tools ---------------------------------------------

/*
 * Multi-turn conversations with tool calls, for the admin agent. Messages
 * are kept in one neutral form and written out in each API's shape. Each
 * model turn, thinking included, is sent back exactly as received, which
 * the APIs require to continue a tool conversation.
 */

/** A tool the model may call, its input described as a JSON schema. */
export interface ConverseTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  content: string;
  isError?: boolean;
}

export type ConverseMessage =
  | { role: 'user'; text: string }
  | {
      role: 'assistant';
      text: string;
      calls: ToolCall[];
      /** The turn as the API sent it, to send back unchanged. */
      raw: unknown;
    }
  | { role: 'tool'; results: ToolResult[] };

export interface ConverseRequest {
  model: string;
  system: string;
  messages: ConverseMessage[];
  tools: ConverseTool[];
  maxTokens: number;
  /** How hard the model thinks; "lowest" if unset. */
  effort?: AiEffort;
}

export interface ConverseTurn extends Completion {
  calls: ToolCall[];
  /** The turn as sent, for the next request. */
  raw: unknown;
}

const anthropicMessages = (messages: ConverseMessage[]) =>
  messages.map((message) => {
    switch (message.role) {
      case 'user':
        return { role: 'user', content: message.text };
      case 'assistant':
        return { role: 'assistant', content: message.raw };
      default:
        return {
          role: 'user',
          content: message.results.map((result) => ({
            type: 'tool_result',
            tool_use_id: result.id,
            content: result.content,
            ...(result.isError ? { is_error: true } : {}),
          })),
        };
    }
  });

const converseAnthropic = async (
  ai: AiSettings,
  req: ConverseRequest
): Promise<ConverseTurn> => {
  const effort = req.effort ?? 'lowest';
  const send = (level: string | null) =>
    axios.post<{
      content: {
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }[];
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    }>(
      `${ANTHROPIC_URL}/messages`,
      {
        model: req.model,
        max_tokens: req.maxTokens + claudeRoom(effort, level),
        system: req.system,
        messages: anthropicMessages(req.messages),
        tools: req.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        })),
        ...(level ? { output_config: { effort: level } } : {}),
      },
      { headers: anthropicHeaders(ai), timeout: COMPLETION_TIMEOUT_MS[effort] }
    );

  let response;
  try {
    response = await withClaudeEffort(req.model, effort, send);
  } catch (e) {
    throw explain(e, 'Claude', ai.apiKey);
  }

  const { data } = response;
  const text = data.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
    .trim();
  const calls = data.content
    .filter((block) => block.type === 'tool_use' && block.id && block.name)
    .map((block) => ({
      id: block.id as string,
      name: block.name as string,
      input: block.input ?? {},
    }));
  if (data.stop_reason === 'refusal') {
    throw new AiProviderError(DECLINED);
  }
  if (!text && !calls.length && data.stop_reason === 'max_tokens') {
    throw new AiProviderError(`Claude ${RAN_OUT}`);
  }
  return {
    text,
    calls,
    raw: data.content,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
  };
};

interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Parses the model's tool arguments, which may not be valid JSON. */
const argumentsOf = (text: string): Record<string, unknown> => {
  try {
    const value = JSON.parse(text || '{}');
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
};

/** The Responses items a turn is kept as: its thinking, words and calls. */
const RESPONSES_TURN = new Set(['reasoning', 'message', 'function_call']);

/** Whether a kept turn came from the Responses API. */
const isResponsesTurn = (raw: unknown): raw is ResponsesItem[] =>
  Array.isArray(raw) &&
  raw.every(
    (item) =>
      !!item &&
      typeof item === 'object' &&
      RESPONSES_TURN.has((item as ResponsesItem).type ?? '')
  );

/** Whether a kept turn is a chat completions message. */
const isChatTurn = (raw: unknown) =>
  !!raw &&
  typeof raw === 'object' &&
  !Array.isArray(raw) &&
  (raw as { role?: unknown }).role === 'assistant';

type AssistantMessage = Extract<ConverseMessage, { role: 'assistant' }>;

const resultText = (result: ToolResult) =>
  result.isError ? `Error: ${result.content}` : result.content;

/**
 * The conversation as Responses input. Each model turn is sent back as it
 * came, encrypted reasoning included; one kept in another API's shape (a
 * conversation saved before, or begun with another server) is rebuilt from
 * its words and calls.
 */
const responsesInput = (messages: ConverseMessage[]) =>
  messages.flatMap((message): unknown[] => {
    switch (message.role) {
      case 'user':
        return [
          {
            role: 'user',
            content: [{ type: 'input_text', text: message.text }],
          },
        ];
      case 'assistant':
        return isResponsesTurn(message.raw)
          ? message.raw
          : [
              ...(message.text
                ? [{ role: 'assistant', content: message.text }]
                : []),
              ...message.calls.map((call) => ({
                type: 'function_call',
                call_id: call.id,
                name: call.name,
                arguments: JSON.stringify(call.input),
              })),
            ];
      default:
        return message.results.map((result) => ({
          type: 'function_call_output',
          call_id: result.id,
          output: resultText(result),
        }));
    }
  });

/** A turn rebuilt as a chat completions message, from its words and calls. */
const chatTurn = (message: AssistantMessage) =>
  isChatTurn(message.raw)
    ? message.raw
    : {
        role: 'assistant',
        content: message.text || null,
        ...(message.calls.length
          ? {
              tool_calls: message.calls.map((call) => ({
                id: call.id,
                type: 'function',
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.input),
                },
              })),
            }
          : {}),
      };

const openAiMessages = (system: string, messages: ConverseMessage[]) => [
  { role: 'system', content: system },
  ...messages.flatMap((message) => {
    switch (message.role) {
      case 'user':
        return [{ role: 'user', content: message.text }];
      case 'assistant':
        return [chatTurn(message)];
      default:
        return message.results.map((result) => ({
          role: 'tool',
          tool_call_id: result.id,
          content: resultText(result),
        }));
    }
  }),
];

const converseResponses = async (
  ai: AiSettings,
  req: ConverseRequest
): Promise<ConverseTurn> => {
  const effortSetting = req.effort ?? 'lowest';
  const tools = req.tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    // Strict schemas need every property required; these are not.
    strict: false,
  }));
  const input = responsesInput(req.messages);
  const send = (effort: string | null) =>
    postResponses(
      ai,
      {
        model: req.model,
        instructions: req.system,
        input,
        ...(tools.length ? { tools } : {}),
        ...responsesLimits(req.model, req.maxTokens, effortSetting, effort),
        store: false,
        // Its thinking, sealed, to send back with the next turn: with
        // nothing stored, that is how it keeps thinking across tool calls.
        ...(isReasoningModel(req.model)
          ? { include: ['reasoning.encrypted_content'] }
          : {}),
      },
      effortSetting
    );

  let data: ResponsesReply;
  try {
    data = await withOpenAiEffort(
      openAiPlan(ai, req.model, effortSetting, true),
      send,
      { refusals: ['reasoning_effort', 'reasoning', 'tools'] }
    );
  } catch (e) {
    throw explain(e, 'OpenAI', ai.apiKey);
  }

  const output = data.output ?? [];
  const text = responsesText(data);
  const calls = output.filter(
    (item) => item.type === 'function_call' && item.call_id && item.name
  );
  if (!text && !calls.length && responsesCutOff(data)) {
    throw new AiProviderError(`OpenAI ${RAN_OUT}`);
  }
  return {
    text,
    calls: calls.map((call) => ({
      id: call.call_id as string,
      name: call.name as string,
      input: argumentsOf(call.arguments ?? ''),
    })),
    raw: output.filter((item) => RESPONSES_TURN.has(item.type ?? '')),
    ...responsesUsage(data),
  };
};

const converseOpenAi = async (
  ai: AiSettings,
  req: ConverseRequest
): Promise<ConverseTurn> => {
  if (isOfficialOpenAi(ai)) {
    return converseResponses(ai, req);
  }
  const name = 'The AI server';
  const tools = req.tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
  const messages = openAiMessages(req.system, req.messages);
  const effortSetting = req.effort ?? 'lowest';
  const room = THINKING_ROOM[effortSetting];

  const send = async (effort: string | null) =>
    (
      await axios.post<{
        choices?: {
          message?: {
            role?: string;
            content?: string | null;
            tool_calls?: OpenAiToolCall[];
          };
          finish_reason?: string;
        }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      }>(
        `${openAiBase(ai)}/chat/completions`,
        {
          model: req.model,
          messages,
          tools,
          max_tokens: effort ? req.maxTokens + room : req.maxTokens,
          ...(effort ? { reasoning_effort: effort } : {}),
        },
        {
          headers: openAiHeaders(ai),
          timeout: COMPLETION_TIMEOUT_MS[effortSetting],
        }
      )
    ).data;

  let data;
  try {
    data = await withOpenAiEffort(
      openAiPlan(ai, req.model, effortSetting, true),
      send,
      { refusals: ['reasoning_effort', 'reasoning', 'tools'] }
    );
  } catch (e) {
    throw explain(e, name, ai.apiKey);
  }

  const choice = data.choices?.[0];
  const message = choice?.message ?? {};
  const text = (message.content ?? '').trim();
  const toolCalls = message.tool_calls ?? [];
  if (!text && !toolCalls.length && choice?.finish_reason === 'length') {
    throw new AiProviderError(`${name} ${RAN_OUT}`);
  }
  return {
    text,
    calls: toolCalls.map((call) => ({
      id: call.id,
      name: call.function.name,
      input: argumentsOf(call.function.arguments),
    })),
    raw: {
      role: 'assistant',
      content: message.content ?? null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    },
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };
};

/**
 * The service is unreachable, busy or too slow: a retry may well succeed,
 * and the failed try cost nothing.
 */
export const isOutage = (e: unknown): e is AiProviderError =>
  e instanceof AiProviderError &&
  (e.code === 'unreachable' || e.code === 'busy' || e.code === 'timeout');

/** One turn of a conversation in which the model may call tools. */
export const converse = (
  ai: AiSettings,
  req: ConverseRequest
): Promise<ConverseTurn> =>
  ai.provider === 'anthropic'
    ? converseAnthropic(ai, req)
    : converseOpenAi(ai, req);
