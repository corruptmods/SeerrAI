import type { AiSettings } from '@server/lib/settings';
import axios, { isAxiosError } from 'axios';

/*
 * The two ways of talking to a model. Kept to the smallest request each API
 * accepts: one system prompt, one user message, a cap on the answer, and the
 * least thinking the model allows. No temperature or sampling settings, which
 * newer models reject anyway.
 *
 * Newer models on both APIs think before answering, and that thinking is
 * billed and counts against the cap. Each request asks for the lowest effort
 * the model accepts and leaves room for it; which level a model accepts is
 * learned from its first refusal and remembered, so it costs one retry per
 * model per restart at most.
 */

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1';
export const OPENAI_URL = 'https://api.openai.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

/** Long enough for a slow model writing a few hundred words. */
const COMPLETION_TIMEOUT_MS = 90_000;
const LIST_TIMEOUT_MS = 15_000;

/**
 * Room for thinking on top of the answer's own cap. Only what is used is
 * billed; without it a thinking model can spend the whole cap and say
 * nothing.
 */
const THINKING_ROOM = 2048;

/** The picture types both APIs take. */
export const IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

/** A picture sent with the message: its type, and its bytes as base64. */
export interface CompletionImage {
  type: ImageType;
  data: string;
}

export interface CompletionRequest {
  model: string;
  system: string;
  prompt: string;
  /** A picture for the model to look at along with the prompt. */
  image?: CompletionImage;
  /** The most the answer itself should need. Every feature sets its own. */
  maxTokens: number;
  /** Ask for a JSON object where the API can enforce it. */
  json?: boolean;
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

/** Something the person setting it up, or using it, can act on. */
export class AiProviderError extends Error {
  constructor(
    message: string,
    public readonly status = 502,
    /** The provider said the account has no credit left. */
    public readonly outOfCredit = false
  ) {
    super(message);
  }
}

const openAiBase = (ai: AiSettings) =>
  (ai.baseUrl.trim() || OPENAI_URL).replace(/\/+$/, '');

const isOfficialOpenAi = (ai: AiSettings) =>
  ai.provider === 'openai' && openAiBase(ai) === OPENAI_URL;

/**
 * The provider that bills for these settings, or null for another server
 * (a home server, or another service's OpenAI-compatible address).
 */
export const billedBy = (ai: AiSettings): 'anthropic' | 'openai' | null =>
  ai.provider === 'anthropic'
    ? 'anthropic'
    : isOfficialOpenAi(ai)
      ? 'openai'
      : null;

/**
 * OpenAI's chat models that do not reason. Everything newer (the o-series,
 * GPT-5 and later) does, and gets the least reasoning it accepts.
 */
export const isReasoningModel = (model: string) =>
  !/^(gpt-4|gpt-3\.5|chatgpt-)/i.test(model.trim());

/** Cheapest first. A model that refuses one is asked with the next. */
const OPENAI_EFFORTS = ['none', 'minimal', 'low'] as const;
const CLAUDE_EFFORT = 'low';

/**
 * What each model accepted: an effort level, or null for "send none". Kept
 * for the life of the process.
 */
const openAiEffort = new Map<string, string | null>();
const claudeEffort = new Map<string, boolean>();

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
 * A refusal of the picture itself: a model that only reads text, or a server
 * that does not take pictures at all, says so in many ways.
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
  // Whatever a server sends back, the key never goes any further.
  const scrub = (text: string) =>
    apiKey ? text.split(apiKey).join('[key]') : text;
  if (!isAxiosError(e)) {
    return new AiProviderError(
      scrub(e instanceof Error ? e.message : `${provider} failed.`)
    );
  }
  if (e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT') {
    return new AiProviderError(`${provider} took too long to answer.`, 504);
  }
  const status = e.response?.status;
  const detail = scrub(detailOf(e)).slice(0, 300);
  if (withImage && refusedPicture(e)) {
    return new AiProviderError(
      'The AI model in use cannot read pictures. An admin can choose one that can in the AI settings.',
      400
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
      true
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
      503
    );
  }
  if (status && status >= 500) {
    return new AiProviderError(
      `${provider} is having trouble right now. Try again shortly.`,
      503
    );
  }
  if (!e.response) {
    return new AiProviderError(`Could not reach ${provider}.`);
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

const completeAnthropic = async (
  ai: AiSettings,
  req: CompletionRequest
): Promise<Completion> => {
  const send = (withEffort: boolean) =>
    axios.post<{
      content: { type: string; text?: string }[];
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    }>(
      `${ANTHROPIC_URL}/messages`,
      {
        model: req.model,
        max_tokens: req.maxTokens + THINKING_ROOM,
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
        ...(withEffort ? { output_config: { effort: CLAUDE_EFFORT } } : {}),
      },
      { headers: anthropicHeaders(ai), timeout: COMPLETION_TIMEOUT_MS }
    );

  let response;
  try {
    const known = claudeEffort.get(req.model);
    try {
      response = await send(known !== false);
      claudeEffort.set(req.model, known !== false);
    } catch (e) {
      // Older models have no effort setting and say so.
      if (known === undefined && refused(e, 'effort', 'output_config')) {
        claudeEffort.set(req.model, false);
        response = await send(false);
      } else {
        throw e;
      }
    }
  } catch (e) {
    throw explain(e, 'Claude', ai.apiKey, !!req.image);
  }

  const { data } = response;
  const text = data.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
    .trim();
  if (!text && data.stop_reason === 'max_tokens') {
    throw new AiProviderError(`Claude ${RAN_OUT}`);
  }
  return {
    text,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
  };
};

interface OpenAiResponse {
  choices?: {
    message?: { content?: string | null };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const completeOpenAi = async (
  ai: AiSettings,
  req: CompletionRequest
): Promise<Completion> => {
  const official = isOfficialOpenAi(ai);
  const reasoning = official && isReasoningModel(req.model);
  const name = official ? 'OpenAI' : 'The AI server';

  // A picture goes as a data URL beside the text, the form OpenAI and the
  // servers that copy it (Ollama, LM Studio, vLLM) all take.
  const user = req.image
    ? [
        { type: 'text', text: req.prompt },
        {
          type: 'image_url',
          image_url: { url: `data:${req.image.type};base64,${req.image.data}` },
        },
      ]
    : req.prompt;

  // OpenAI itself: its current names for the cap and the system role, JSON
  // enforced, and the least reasoning. Other servers get the long-standing
  // form every OpenAI-compatible server understands.
  const body = (effort: string | null, json: boolean) =>
    official
      ? {
          model: req.model,
          messages: [
            { role: 'developer', content: req.system },
            { role: 'user', content: user },
          ],
          max_completion_tokens: reasoning
            ? req.maxTokens + THINKING_ROOM
            : req.maxTokens,
          ...(effort ? { reasoning_effort: effort } : {}),
          ...(json ? { response_format: { type: 'json_object' } } : {}),
        }
      : {
          model: req.model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: user },
          ],
          max_tokens: req.maxTokens,
        };

  const send = (effort: string | null, json: boolean) =>
    axios.post<OpenAiResponse>(
      `${openAiBase(ai)}/chat/completions`,
      body(effort, json),
      { headers: openAiHeaders(ai), timeout: COMPLETION_TIMEOUT_MS }
    );

  // The efforts still to try for this model, cheapest first.
  const known = openAiEffort.get(req.model);
  const efforts: (string | null)[] = !reasoning
    ? [null]
    : known !== undefined
      ? [known]
      : [...OPENAI_EFFORTS, null];
  let json = !!req.json;

  let data: OpenAiResponse | undefined;
  let lastError: unknown;
  for (let i = 0; i < efforts.length && !data; ) {
    try {
      data = (await send(efforts[i], json)).data;
      if (reasoning) {
        openAiEffort.set(req.model, efforts[i]);
      }
    } catch (e) {
      lastError = e;
      if (json && refused(e, 'response_format')) {
        json = false;
      } else if (efforts[i] && refused(e, 'reasoning_effort', 'reasoning')) {
        i += 1;
      } else {
        break;
      }
    }
  }
  if (!data) {
    throw explain(lastError, name, ai.apiKey, !!req.image);
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
 * OpenAI's list includes models this cannot use: speech, images,
 * embeddings, and ones only its newer Responses API serves.
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
 * For the admin agent: several turns, where the model may ask to run tools
 * and is given their results. The messages are kept in one neutral form and
 * written out in each API's own shape. What the model said in a turn, its
 * thinking included, is sent back exactly as it came, which both APIs need
 * for a conversation with tools to go on.
 */

/** A tool the model may ask for, its input described as a JSON schema. */
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
  const send = (withEffort: boolean) =>
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
        max_tokens: req.maxTokens + THINKING_ROOM,
        system: req.system,
        messages: anthropicMessages(req.messages),
        tools: req.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        })),
        ...(withEffort ? { output_config: { effort: CLAUDE_EFFORT } } : {}),
      },
      { headers: anthropicHeaders(ai), timeout: COMPLETION_TIMEOUT_MS }
    );

  let response;
  try {
    const known = claudeEffort.get(req.model);
    try {
      response = await send(known !== false);
      claudeEffort.set(req.model, known !== false);
    } catch (e) {
      if (known === undefined && refused(e, 'effort', 'output_config')) {
        claudeEffort.set(req.model, false);
        response = await send(false);
      } else {
        throw e;
      }
    }
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

/** The model's arguments: JSON it wrote, which may not be. */
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

const openAiMessages = (
  system: string,
  official: boolean,
  messages: ConverseMessage[]
) => [
  { role: official ? 'developer' : 'system', content: system },
  ...messages.flatMap((message) => {
    switch (message.role) {
      case 'user':
        return [{ role: 'user', content: message.text }];
      case 'assistant':
        return [message.raw];
      default:
        return message.results.map((result) => ({
          role: 'tool',
          tool_call_id: result.id,
          content: result.isError ? `Error: ${result.content}` : result.content,
        }));
    }
  }),
];

const converseOpenAi = async (
  ai: AiSettings,
  req: ConverseRequest
): Promise<ConverseTurn> => {
  const official = isOfficialOpenAi(ai);
  const reasoning = official && isReasoningModel(req.model);
  const name = official ? 'OpenAI' : 'The AI server';
  const tools = req.tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
  const messages = openAiMessages(req.system, official, req.messages);

  const send = (effort: string | null) =>
    axios.post<{
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
      official
        ? {
            model: req.model,
            messages,
            tools,
            max_completion_tokens: reasoning
              ? req.maxTokens + THINKING_ROOM
              : req.maxTokens,
            ...(effort ? { reasoning_effort: effort } : {}),
          }
        : { model: req.model, messages, tools, max_tokens: req.maxTokens },
      { headers: openAiHeaders(ai), timeout: COMPLETION_TIMEOUT_MS }
    );

  // Tools rule out the very least reasoning on some models, so "none" and
  // "minimal" may each be refused once before "low" is remembered.
  const known = openAiEffort.get(req.model);
  const efforts: (string | null)[] = !reasoning
    ? [null]
    : known !== undefined
      ? [known]
      : [...OPENAI_EFFORTS, null];
  let data;
  let lastError: unknown;
  for (let i = 0; i < efforts.length && !data; ) {
    try {
      data = (await send(efforts[i])).data;
      if (reasoning) {
        openAiEffort.set(req.model, efforts[i]);
      }
    } catch (e) {
      lastError = e;
      if (efforts[i] && refused(e, 'reasoning_effort', 'reasoning', 'tools')) {
        i += 1;
      } else {
        break;
      }
    }
  }
  if (!data) {
    throw explain(lastError, name, ai.apiKey);
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

/** One turn of a conversation in which the model may call tools. */
export const converse = (
  ai: AiSettings,
  req: ConverseRequest
): Promise<ConverseTurn> =>
  ai.provider === 'anthropic'
    ? converseAnthropic(ai, req)
    : converseOpenAi(ai, req);
