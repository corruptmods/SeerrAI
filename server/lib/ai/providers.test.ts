import type { AiProviderError } from '@server/lib/ai/providers';
import {
  ANTHROPIC_URL,
  OPENAI_URL,
  complete,
  converse,
  isReasoningModel,
  listModels,
  resetProviderMemoryForTests,
} from '@server/lib/ai/providers';
import type { AiSettings } from '@server/lib/settings';
import axios, { AxiosError, AxiosHeaders } from 'axios';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

/*
 * What each API is actually sent: the smallest request it accepts, shaped
 * for each kind of model.
 */

const settings = (over: Partial<AiSettings> = {}): AiSettings => ({
  enabled: true,
  provider: 'anthropic',
  apiKey: 'test-key',
  baseUrl: '',
  model: 'claude-test',
  featureModels: {},
  dailyLimit: 0,
  ...over,
});

interface Sent {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

const capture = (
  replies: (unknown | ((body: Record<string, unknown>) => unknown))[]
) => {
  const sent: Sent[] = [];
  mock.method(
    axios,
    'post',
    async (url: string, body: Record<string, unknown>, config: never) => {
      sent.push({
        url,
        body,
        headers: (config as { headers: Record<string, string> }).headers,
      });
      const reply = replies.shift();
      const value = typeof reply === 'function' ? reply(body) : reply;
      if (value instanceof Error) {
        throw value;
      }
      return { data: value };
    }
  );
  return sent;
};

const httpError = (status: number, data: unknown) =>
  new AxiosError('failed', 'ERR_BAD_REQUEST', undefined, undefined, {
    status,
    data,
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
  });

const request = { model: 'm', system: 'sys', prompt: 'hi', maxTokens: 100 };

/** OpenAI's Responses API answering with text, after any other items. */
const responsesReply = (text: string, before: unknown[] = []) => ({
  status: 'completed',
  output: [
    ...before,
    {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    },
  ],
  usage: { input_tokens: 20, output_tokens: 5 },
});

/** The effort a Responses request asked for. */
const effortOf = (s: Sent) =>
  (s.body.reasoning as { effort?: string } | undefined)?.effort;

afterEach(() => {
  mock.restoreAll();
  resetProviderMemoryForTests();
});

describe('Claude', () => {
  it('sends one system prompt, one message, a cap and the least thinking', async () => {
    const sent = capture([
      {
        content: [{ type: 'text', text: ' Hello ' }],
        usage: { input_tokens: 12, output_tokens: 3 },
      },
    ]);
    const answer = await complete(settings(), {
      ...request,
      model: 'claude-haiku',
    });

    assert.equal(sent[0].url, `${ANTHROPIC_URL}/messages`);
    assert.deepEqual(sent[0].body, {
      model: 'claude-haiku',
      // Room for thinking, which counts against the cap on newer models.
      max_tokens: 100 + 2048,
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      output_config: { effort: 'low' },
    });
    assert.equal(sent[0].headers['x-api-key'], 'test-key');
    assert.ok(sent[0].headers['anthropic-version']);
    assert.deepEqual(answer, {
      text: 'Hello',
      inputTokens: 12,
      outputTokens: 3,
    });
  });

  it('drops the effort setting for a model without one, and remembers', async () => {
    const sent = capture([
      httpError(400, {
        error: {
          message: 'output_config.effort: Extra inputs are not permitted',
        },
      }),
      { content: [{ type: 'text', text: 'one' }] },
      { content: [{ type: 'text', text: 'two' }] },
    ]);
    assert.equal((await complete(settings(), request)).text, 'one');
    assert.equal((await complete(settings(), request)).text, 'two');
    assert.equal(sent.length, 3);
    assert.equal(sent[1].body.output_config, undefined);
    assert.equal(sent[2].body.output_config, undefined, 'not asked again');
  });

  it('says so when thinking used up the whole answer', async () => {
    capture([
      {
        content: [{ type: 'thinking', thinking: '...' }],
        stop_reason: 'max_tokens',
      },
    ]);
    await assert.rejects(
      complete(settings(), request),
      /used up its answer length/
    );
  });

  it('never repeats the key, whatever the server sends back', async () => {
    capture([httpError(400, { error: { message: 'bad header: test-key' } })]);
    await assert.rejects(complete(settings(), request), (e: Error) => {
      assert.ok(!e.message.includes('test-key'));
      return true;
    });
  });

  it('says plainly when the key is wrong', async () => {
    capture([httpError(401, { error: { message: 'invalid x-api-key' } })]);
    await assert.rejects(complete(settings(), request), (e: AiProviderError) =>
      /rejected the API key/.test(e.message)
    );
  });

  it('names the model problem when the model does not exist', async () => {
    capture([httpError(404, { error: { message: 'model: nope' } })]);
    await assert.rejects(
      complete(settings(), request),
      /does not know that model: model: nope/
    );
  });
});

describe('OpenAI', () => {
  const openai = (over: Partial<AiSettings> = {}) =>
    settings({ provider: 'openai', ...over });
  const reply = (text: string, finish = 'stop') => ({
    choices: [{ message: { content: text }, finish_reason: finish }],
    usage: { prompt_tokens: 20, completion_tokens: 5 },
  });

  it('uses the Responses API on its own servers, with JSON enforced when asked', async () => {
    const sent = capture([responsesReply(' {"a":1} ')]);
    const answer = await complete(openai(), {
      ...request,
      model: 'gpt-4.1-mini',
      json: true,
    });

    assert.equal(sent[0].url, `${OPENAI_URL}/responses`);
    assert.deepEqual(sent[0].body, {
      model: 'gpt-4.1-mini',
      instructions: 'sys',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      max_output_tokens: 100,
      text: { format: { type: 'json_object' } },
      store: false,
    });
    assert.equal(sent[0].headers.authorization, 'Bearer test-key');
    assert.deepEqual(answer, {
      text: '{"a":1}',
      inputTokens: 20,
      outputTokens: 5,
    });
  });

  it('reads the text of every message, after any reasoning', async () => {
    capture([
      {
        output: [
          { type: 'reasoning', id: 'rs_1', summary: [] },
          {
            type: 'message',
            content: [
              { type: 'output_text', text: 'Hello ' },
              { type: 'refusal', refusal: 'no' },
            ],
          },
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'there' }],
          },
        ],
      },
    ]);
    const answer = await complete(openai(), { ...request, model: 'o3' });
    assert.deepEqual(answer, {
      text: 'Hello there',
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('asks reasoning models for the least effort each accepts, and remembers it', async () => {
    const effortRefused = (value: string) =>
      httpError(400, {
        error: {
          message: `Unsupported value: 'reasoning.effort' does not support '${value}' with this model.`,
        },
      });
    const sent = capture([
      effortRefused('none'),
      effortRefused('minimal'),
      responsesReply('ok'),
      responsesReply('again'),
    ]);
    await complete(openai(), { ...request, model: 'gpt-6-luna' });
    await complete(openai(), { ...request, model: 'gpt-6-luna' });
    assert.deepEqual(sent.map(effortOf), ['none', 'minimal', 'low', 'low']);
    assert.equal(sent[0].body.max_output_tokens, 100 + 2048);
    assert.ok(isReasoningModel('gpt-5.6-terra'));
    assert.ok(isReasoningModel('o4-mini'));
    assert.ok(!isReasoningModel('gpt-4o'));
    assert.ok(!isReasoningModel('gpt-4.1-mini'));
  });

  it('speaks the plain form to other servers, with no key if none is set', async () => {
    const sent = capture([reply('ok')]);
    await complete(
      openai({ baseUrl: 'http://nas.local:11434/v1/', apiKey: '' }),
      { ...request, json: true }
    );
    assert.equal(sent[0].url, 'http://nas.local:11434/v1/chat/completions');
    assert.deepEqual(sent[0].body, {
      model: 'm',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
      max_tokens: 100,
    });
    assert.equal(sent[0].headers.authorization, undefined);
  });

  it('drops JSON mode if a model refuses it', async () => {
    const sent = capture([
      httpError(400, {
        error: {
          message:
            "Unsupported parameter: 'text.format' of type 'json_object' is not supported with this model.",
        },
      }),
      responsesReply('{}'),
    ]);
    await complete(openai(), { ...request, model: 'gpt-4o', json: true });
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0].body.text, { format: { type: 'json_object' } });
    assert.equal(sent[1].body.text, undefined);
    assert.equal(sent[1].body.max_output_tokens, 100);
  });

  it('reports any other refusal as it is, without a second try', async () => {
    const sent = capture([
      httpError(400, { error: { message: 'This model context is too long' } }),
    ]);
    await assert.rejects(
      complete(openai(), { ...request, model: 'gpt-4o' }),
      /context is too long/
    );
    assert.equal(sent.length, 1);
  });

  it('explains an answer lost to thinking instead of returning nothing', async () => {
    const incomplete = (output: unknown[]) => ({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output,
    });
    capture([
      incomplete([{ type: 'reasoning', id: 'rs_1', summary: [] }]),
      incomplete([
        { type: 'message', content: [{ type: 'output_text', text: 'Part' }] },
      ]),
      reply('', 'length'),
    ]);
    await assert.rejects(
      complete(openai(), { ...request, model: 'o3' }),
      /OpenAI used up its answer length/
    );
    // What it did write is kept.
    assert.equal(
      (await complete(openai(), { ...request, model: 'o3' })).text,
      'Part'
    );
    // Other servers say so as chat completions do.
    await assert.rejects(
      complete(openai({ baseUrl: 'http://nas.local:11434/v1' }), request),
      /The AI server used up its answer length/
    );
  });
});

describe('a picture with the message', () => {
  const image = { type: 'image/jpeg' as const, data: '/9j/4AAQ' };

  it('goes to Claude as an image block ahead of the text', async () => {
    const sent = capture([{ content: [{ type: 'text', text: 'ok' }] }]);
    await complete(settings(), { ...request, image });
    assert.deepEqual(
      (sent[0].body.messages as { content: unknown }[])[0].content,
      [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: '/9j/4AAQ',
          },
        },
        { type: 'text', text: 'hi' },
      ]
    );
  });

  it('goes to OpenAI as an input image after the text', async () => {
    const sent = capture([responsesReply('ok')]);
    await complete(settings({ provider: 'openai' }), {
      ...request,
      model: 'gpt-4.1-mini',
      image,
    });
    assert.deepEqual(sent[0].body.input, [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'hi' },
          {
            type: 'input_image',
            image_url: 'data:image/jpeg;base64,/9j/4AAQ',
            detail: 'auto',
          },
        ],
      },
    ]);
  });

  it('goes to servers like OpenAI as a data URL beside the text', async () => {
    const sent = capture([{ choices: [{ message: { content: 'ok' } }] }]);
    await complete(
      settings({ provider: 'openai', baseUrl: 'http://nas.local:11434/v1' }),
      { ...request, image }
    );
    assert.deepEqual(
      (sent[0].body.messages as { content: unknown }[])[1].content,
      [
        { type: 'text', text: 'hi' },
        {
          type: 'image_url',
          image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ' },
        },
      ]
    );
  });

  it('says so plainly when the model only reads text', async () => {
    capture([
      httpError(400, {
        error: {
          message:
            'Invalid content type. image_url is only supported by certain models.',
        },
      }),
    ]);
    await assert.rejects(
      complete(settings({ provider: 'openai' }), {
        ...request,
        model: 'gpt-3.5-turbo',
        image,
      }),
      /cannot read pictures/
    );
    // The same refusal without a picture is reported unchanged.
    capture([httpError(400, { error: { message: 'image_url is wrong' } })]);
    await assert.rejects(
      complete(settings({ provider: 'openai' }), {
        ...request,
        model: 'gpt-3.5-turbo',
      }),
      /refused the request: image_url is wrong/
    );
  });
});

describe('running out of credit', () => {
  const outOfCredit = async (
    over: Partial<AiSettings>,
    status: number,
    data: unknown
  ) => {
    capture([httpError(status, data)]);
    try {
      await complete(settings(over), request);
    } catch (e) {
      return e as AiProviderError;
    }
    throw new Error('the request did not fail');
  };

  it("recognises Anthropic's low credit balance", async () => {
    const e = await outOfCredit({}, 400, {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message:
          'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
      },
    });
    assert.equal(e.outOfCredit, true);
    assert.equal(e.status, 503);
    assert.match(e.message, /Anthropic account is out of credit/);
  });

  it("recognises Anthropic's billing error", async () => {
    const e = await outOfCredit({}, 402, {
      type: 'error',
      error: { type: 'billing_error', message: 'Billing problem.' },
    });
    assert.equal(e.outOfCredit, true);
  });

  it("recognises OpenAI's used-up quota, and not its rate limit", async () => {
    const openai = { provider: 'openai' as const, model: 'gpt-4o-mini' };
    const quota = await outOfCredit(openai, 429, {
      error: {
        message:
          'You exceeded your current quota, please check your plan and billing details.',
        type: 'insufficient_quota',
        code: 'insufficient_quota',
      },
    });
    assert.equal(quota.outOfCredit, true);
    assert.match(quota.message, /OpenAI account is out of credit/);

    const limited = await outOfCredit(openai, 429, {
      error: {
        message: 'Rate limit reached for gpt-4o-mini.',
        type: 'requests',
        code: 'rate_limit_exceeded',
      },
    });
    assert.equal(limited.outOfCredit, false);
    assert.match(limited.message, /limiting requests/);
  });
});

describe('listing models', () => {
  it('offers only the chat models from OpenAI, newest first', async () => {
    mock.method(axios, 'get', async () => ({
      data: {
        data: [
          { id: 'gpt-4o-mini', created: 1 },
          { id: 'text-embedding-3-small', created: 5 },
          { id: 'gpt-4o-realtime-preview', created: 6 },
          { id: 'dall-e-3', created: 7 },
          { id: 'o4-mini', created: 3 },
          { id: 'gpt-5', created: 4 },
          { id: 'gpt-5-pro', created: 8 },
          { id: 'gpt-live-1', created: 9 },
          { id: 'o3-deep-research', created: 10 },
        ],
      },
    }));
    const models = await listModels(settings({ provider: 'openai' }));
    assert.deepEqual(
      models.map((m) => m.id),
      ['gpt-5', 'o4-mini', 'gpt-4o-mini']
    );
  });

  it("shows Claude's own names for its models", async () => {
    mock.method(axios, 'get', async () => ({
      data: { data: [{ id: 'claude-x-1', display_name: 'Claude X' }] },
    }));
    assert.deepEqual(await listModels(settings()), [
      { id: 'claude-x-1', name: 'Claude X' },
    ]);
  });

  it('lists everything a local server has', async () => {
    mock.method(axios, 'get', async () => ({
      data: { data: [{ id: 'llama3.1:8b' }, { id: 'nomic-embed' }] },
    }));
    const models = await listModels(
      settings({ provider: 'openai', baseUrl: 'http://nas:11434/v1' })
    );
    assert.equal(models.length, 2);
  });
});

describe('a conversation with tools', () => {
  const tools = [
    {
      name: 'title_status',
      description: 'What a title has and lacks',
      parameters: {
        type: 'object',
        properties: { ref: { type: 'string' } },
        required: ['ref'],
      },
    },
  ];

  it('gives Claude the tools, and its own turn back unchanged with the results', async () => {
    const turn = [
      { type: 'thinking', thinking: 'look it up', signature: 'sig' },
      { type: 'text', text: 'Checking.' },
      {
        type: 'tool_use',
        id: 'tu_1',
        name: 'title_status',
        input: { ref: 's1' },
      },
    ];
    const sent = capture([
      {
        content: turn,
        stop_reason: 'tool_use',
        usage: { input_tokens: 50, output_tokens: 9 },
      },
      { content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' },
    ]);
    const first = await converse(settings(), {
      model: 'claude-x',
      system: 'sys',
      messages: [{ role: 'user', text: 'find Wendle' }],
      tools,
      maxTokens: 800,
    });
    assert.deepEqual(first.calls, [
      { id: 'tu_1', name: 'title_status', input: { ref: 's1' } },
    ]);
    assert.equal(first.text, 'Checking.');
    assert.deepEqual(sent[0].body.tools, [
      {
        name: 'title_status',
        description: 'What a title has and lacks',
        input_schema: tools[0].parameters,
      },
    ]);

    const second = await converse(settings(), {
      model: 'claude-x',
      system: 'sys',
      messages: [
        { role: 'user', text: 'find Wendle' },
        {
          role: 'assistant',
          text: first.text,
          calls: first.calls,
          raw: first.raw,
        },
        {
          role: 'tool',
          results: [{ id: 'tu_1', content: 'missing 3', isError: false }],
        },
      ],
      tools,
      maxTokens: 800,
    });
    assert.equal(second.text, 'Done.');
    assert.deepEqual(sent[1].body.messages, [
      { role: 'user', content: 'find Wendle' },
      { role: 'assistant', content: turn },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'missing 3' },
        ],
      },
    ]);
  });

  it('gives OpenAI flat functions, and reads the calls it made', async () => {
    const call = {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'title_status',
      arguments: '{"ref":"s1"}',
      status: 'completed',
    };
    const sent = capture([
      {
        status: 'completed',
        output: [call],
        usage: { input_tokens: 50, output_tokens: 9 },
      },
      responsesReply('Nothing to do.'),
    ]);
    const ai = settings({ provider: 'openai', model: 'gpt-4o' });
    const first = await converse(ai, {
      model: 'gpt-4o',
      system: 'sys',
      messages: [{ role: 'user', text: 'find Wendle' }],
      tools,
      maxTokens: 800,
    });
    assert.deepEqual(first.calls, [
      { id: 'call_1', name: 'title_status', input: { ref: 's1' } },
    ]);
    assert.equal(first.text, '');
    assert.deepEqual([first.inputTokens, first.outputTokens], [50, 9]);
    assert.equal(sent[0].url, `${OPENAI_URL}/responses`);
    // A model that does not reason gets no effort and no reasoning back.
    assert.deepEqual(sent[0].body, {
      model: 'gpt-4o',
      instructions: 'sys',
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'find Wendle' }],
        },
      ],
      tools: [
        {
          type: 'function',
          name: 'title_status',
          description: 'What a title has and lacks',
          parameters: tools[0].parameters,
          strict: false,
        },
      ],
      max_output_tokens: 800,
      store: false,
    });

    const second = await converse(ai, {
      model: 'gpt-4o',
      system: 'sys',
      messages: [
        { role: 'user', text: 'find Wendle' },
        { role: 'assistant', text: '', calls: first.calls, raw: first.raw },
        {
          role: 'tool',
          results: [{ id: 'call_1', content: 'not found', isError: true }],
        },
      ],
      tools,
      maxTokens: 800,
    });
    assert.equal(second.text, 'Nothing to do.');
    assert.deepEqual(sent[1].body.input, [
      { role: 'user', content: [{ type: 'input_text', text: 'find Wendle' }] },
      call,
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'Error: not found',
      },
    ]);
  });

  it('sends GPT-6 Luna tools and an effort together, and its reasoning back unchanged', async () => {
    const reasoning = {
      type: 'reasoning',
      id: 'rs_1',
      summary: [],
      encrypted_content: 'sealed-thoughts',
    };
    const said = {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      phase: 'commentary',
      content: [{ type: 'output_text', text: 'Checking.', annotations: [] }],
    };
    const call = {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_9',
      name: 'title_status',
      arguments: '{"ref":"s1"}',
    };
    const sent = capture([
      { status: 'completed', output: [reasoning, said, call] },
      responsesReply('Done.'),
    ]);
    const ai = settings({ provider: 'openai', model: 'gpt-6-luna' });
    const req = {
      model: 'gpt-6-luna',
      system: 'sys',
      tools,
      maxTokens: 800,
      effort: 'medium' as const,
    };
    const first = await converse(ai, {
      ...req,
      messages: [{ role: 'user', text: 'find Wendle' }],
    });
    assert.equal(first.text, 'Checking.');
    assert.deepEqual(first.calls, [
      { id: 'call_9', name: 'title_status', input: { ref: 's1' } },
    ]);
    assert.deepEqual(first.raw, [reasoning, said, call]);
    assert.equal(sent[0].url, `${OPENAI_URL}/responses`);
    assert.deepEqual(sent[0].body.reasoning, { effort: 'medium' });
    assert.deepEqual(sent[0].body.include, ['reasoning.encrypted_content']);
    assert.equal(sent[0].body.store, false);
    assert.equal(sent[0].body.max_output_tokens, 800 + 8192);
    assert.equal((sent[0].body.tools as unknown[]).length, 1);

    await converse(ai, {
      ...req,
      messages: [
        { role: 'user', text: 'find Wendle' },
        {
          role: 'assistant',
          text: first.text,
          calls: first.calls,
          raw: first.raw,
        },
        { role: 'tool', results: [{ id: 'call_9', content: 'missing 3' }] },
      ],
    });
    assert.deepEqual(sent[1].body.input, [
      { role: 'user', content: [{ type: 'input_text', text: 'find Wendle' }] },
      reasoning,
      said,
      call,
      { type: 'function_call_output', call_id: 'call_9', output: 'missing 3' },
    ]);
    assert.deepEqual(sent[1].body.reasoning, { effort: 'medium' });
  });

  it('rebuilds a turn kept in another shape for OpenAI, and for other servers', async () => {
    const calls = [
      { id: 'call_1', name: 'title_status', input: { ref: 's1' } },
    ];
    const chatTurn = {
      role: 'assistant',
      content: 'Checking.',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'title_status', arguments: '{"ref":"s1"}' },
        },
      ],
    };
    const responsesTurn = [
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'title_status',
        arguments: '{"ref":"s1"}',
      },
    ];
    const conversation = (raw: unknown) => ({
      model: 'gpt-5',
      system: 'sys',
      messages: [
        { role: 'user' as const, text: 'find Wendle' },
        { role: 'assistant' as const, text: 'Checking.', calls, raw },
        { role: 'tool' as const, results: [{ id: 'call_1', content: 'ok' }] },
      ],
      tools,
      maxTokens: 800,
    });
    const sent = capture([
      responsesReply('Done.'),
      { choices: [{ message: { content: 'Done.' } }] },
    ]);
    // Saved before OpenAI moved to the Responses API.
    await converse(settings({ provider: 'openai' }), conversation(chatTurn));
    assert.deepEqual((sent[0].body.input as unknown[])[1], {
      role: 'assistant',
      content: 'Checking.',
    });
    assert.deepEqual((sent[0].body.input as unknown[])[2], {
      type: 'function_call',
      call_id: 'call_1',
      name: 'title_status',
      arguments: '{"ref":"s1"}',
    });
    // Begun with OpenAI, carried on with another server.
    await converse(
      settings({ provider: 'openai', baseUrl: 'http://local:1234/v1' }),
      conversation(responsesTurn)
    );
    assert.deepEqual((sent[1].body.messages as unknown[])[2], chatTurn);
  });

  it('gives other servers functions on chat completions, as before', async () => {
    const sent = capture([
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'title_status', arguments: '{"ref":"s1"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      { choices: [{ message: { content: 'Nothing to do.' } }] },
    ]);
    const ai = settings({
      provider: 'openai',
      baseUrl: 'http://nas.local:11434/v1',
      model: 'qwen3',
    });
    const first = await converse(ai, {
      model: 'qwen3',
      system: 'sys',
      messages: [{ role: 'user', text: 'find Wendle' }],
      tools,
      maxTokens: 800,
    });
    assert.deepEqual(first.calls, [
      { id: 'call_1', name: 'title_status', input: { ref: 's1' } },
    ]);
    assert.equal(sent[0].url, 'http://nas.local:11434/v1/chat/completions');
    assert.deepEqual(sent[0].body, {
      model: 'qwen3',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'find Wendle' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'title_status',
            description: 'What a title has and lacks',
            parameters: tools[0].parameters,
          },
        },
      ],
      max_tokens: 800,
    });

    await converse(ai, {
      model: 'qwen3',
      system: 'sys',
      messages: [
        { role: 'user', text: 'find Wendle' },
        { role: 'assistant', text: '', calls: first.calls, raw: first.raw },
        {
          role: 'tool',
          results: [{ id: 'call_1', content: 'not found', isError: true }],
        },
      ],
      tools,
      maxTokens: 800,
    });
    const messages = sent[1].body.messages as Record<string, unknown>[];
    assert.deepEqual(messages[2], first.raw);
    assert.deepEqual(messages[3], {
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'Error: not found',
    });
  });

  it('takes OpenAI arguments that are not JSON as none', async () => {
    capture([
      {
        output: [
          {
            type: 'function_call',
            call_id: 'c',
            name: 'title_status',
            arguments: '{oops',
          },
        ],
      },
    ]);
    const turn = await converse(settings({ provider: 'openai' }), {
      model: 'gpt-5',
      system: 'sys',
      messages: [{ role: 'user', text: 'hi' }],
      tools,
      maxTokens: 100,
    });
    assert.deepEqual(turn.calls, [
      { id: 'c', name: 'title_status', input: {} },
    ]);
  });

  it('says when OpenAI ran out of room before calling or saying anything', async () => {
    capture([
      {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [{ type: 'reasoning', id: 'rs_1', summary: [] }],
      },
    ]);
    await assert.rejects(
      converse(settings({ provider: 'openai' }), {
        model: 'gpt-6-luna',
        system: 'sys',
        messages: [{ role: 'user', text: 'hi' }],
        tools,
        maxTokens: 100,
      }),
      /OpenAI used up its answer length/
    );
  });

  it('takes arguments that are not JSON as none', async () => {
    capture([
      {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'c',
                  type: 'function',
                  function: { name: 'title_status', arguments: '{oops' },
                },
              ],
            },
          },
        ],
      },
    ]);
    const turn = await converse(
      settings({ provider: 'openai', baseUrl: 'http://local:1234/v1' }),
      {
        model: 'llama',
        system: 'sys',
        messages: [{ role: 'user', text: 'hi' }],
        tools,
        maxTokens: 100,
      }
    );
    assert.deepEqual(turn.calls[0].input, {});
  });
});

describe('effort', () => {
  const claudeReply = { content: [{ type: 'text', text: 'ok' }] };
  // OpenAI's own reply, and another server's.
  const openAiReply = responsesReply('ok');
  const chatReply = {
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
  };
  const openai = (over: Partial<AiSettings> = {}) =>
    settings({ provider: 'openai', ...over });
  const effortRefused = (value: string) =>
    httpError(400, {
      error: {
        message: `Unsupported value: 'reasoning.effort' does not support '${value}' with this model.`,
      },
    });

  it('asks Claude for each level, with more room to think the higher it is', async () => {
    const sent = capture([claudeReply, claudeReply, claudeReply, claudeReply]);
    for (const effort of ['lowest', 'low', 'medium', 'high'] as const) {
      await complete(settings(), { ...request, effort });
    }
    assert.deepEqual(
      sent.map((s) => (s.body.output_config as { effort: string }).effort),
      ['low', 'low', 'medium', 'high']
    );
    assert.deepEqual(
      sent.map((s) => s.body.max_tokens),
      [100 + 2048, 100 + 2048, 100 + 8192, 100 + 16384]
    );
  });

  it('remembers a Claude model without effort per level asked', async () => {
    const sent = capture([
      httpError(400, {
        error: {
          message: 'output_config.effort: Extra inputs are not permitted',
        },
      }),
      claudeReply,
      claudeReply,
    ]);
    await complete(settings(), request);
    // "high" was never refused, so it is asked for.
    await complete(settings(), { ...request, effort: 'high' });
    assert.deepEqual(
      sent.map((s) => s.body.output_config),
      [{ effort: 'low' }, undefined, { effort: 'high' }]
    );
  });

  it('gives a Claude model that takes no effort only the least room to think', async () => {
    const sent = capture([
      httpError(400, {
        error: {
          message: 'output_config.effort: Extra inputs are not permitted',
        },
      }),
      claudeReply,
      claudeReply,
    ]);
    await complete(settings(), { ...request, effort: 'high' });
    await complete(settings(), { ...request, effort: 'high' });
    assert.deepEqual(
      sent.map((s) => [s.body.output_config, s.body.max_tokens]),
      [
        [{ effort: 'high' }, 100 + 16384],
        [undefined, 100 + 2048],
        [undefined, 100 + 2048],
      ]
    );
  });

  it('asks an OpenAI reasoning model for the level set, then lower ones it accepts', async () => {
    const sent = capture([
      effortRefused('high'),
      openAiReply,
      openAiReply,
      openAiReply,
    ]);
    const luna = { ...request, model: 'gpt-6-luna' };
    await complete(openai(), { ...luna, effort: 'high' });
    await complete(openai(), { ...luna, effort: 'high' });
    // Another level is not answered from what "high" learned.
    await complete(openai(), { ...luna, effort: 'low' });
    assert.deepEqual(sent.map(effortOf), ['high', 'medium', 'medium', 'low']);
    assert.ok(sent.every((s) => s.url === `${OPENAI_URL}/responses`));
    assert.equal(sent[0].body.max_output_tokens, 100 + 16384);
    assert.equal(sent[3].body.max_output_tokens, 100 + 2048);
  });

  it('keeps the cheapest-first order for "lowest", the default', async () => {
    const sent = capture([effortRefused('none'), openAiReply, openAiReply]);
    await complete(openai(), {
      ...request,
      model: 'gpt-6-luna',
      effort: 'lowest',
    });
    // No effort given is the same setting, so it is remembered for it.
    await complete(openai(), { ...request, model: 'gpt-6-luna' });
    assert.deepEqual(sent.map(effortOf), ['none', 'minimal', 'minimal']);
  });

  it('sends no effort to OpenAI models that do not reason', async () => {
    const sent = capture([openAiReply]);
    await complete(openai(), { ...request, model: 'gpt-4o', effort: 'high' });
    assert.equal(sent[0].body.reasoning, undefined);
    assert.equal(sent[0].body.max_output_tokens, 100);
  });

  it('sends other servers an effort only when one is chosen, dropping it if refused', async () => {
    const local = openai({ baseUrl: 'http://nas.local:11434/v1', apiKey: '' });
    const sent = capture([
      chatReply,
      httpError(400, { error: { message: 'unknown field reasoning_effort' } }),
      chatReply,
      chatReply,
    ]);
    await complete(local, { ...request, effort: 'lowest' });
    await complete(local, { ...request, effort: 'medium' });
    await complete(local, { ...request, effort: 'medium' });
    assert.deepEqual(
      sent.map((s) => s.body.reasoning_effort),
      [undefined, 'medium', undefined, undefined]
    );
    assert.equal(sent[0].body.max_tokens, 100);
    assert.equal(sent[1].body.max_tokens, 100 + 8192);
    assert.equal(sent[3].body.max_tokens, 100, 'remembered as refused');
  });

  it('applies to a conversation with tools too', async () => {
    const sent = capture([
      { content: [{ type: 'text', text: 'done' }] },
      effortRefused('medium'),
      openAiReply,
    ]);
    const req = {
      system: 'sys',
      messages: [{ role: 'user' as const, text: 'hi' }],
      tools: [],
      maxTokens: 800,
      effort: 'medium' as const,
    };
    await converse(settings(), { ...req, model: 'claude-test' });
    await converse(openai(), { ...req, model: 'gpt-6-luna' });
    assert.deepEqual(sent[0].body.output_config, { effort: 'medium' });
    assert.equal(sent[0].body.max_tokens, 800 + 8192);
    assert.deepEqual(sent.slice(1).map(effortOf), ['medium', 'low']);
  });

  it('asks for no thinking with None: none to OpenAI and other servers, low to Claude', async () => {
    const sent = capture([openAiReply, chatReply, claudeReply]);
    await complete(openai(), {
      ...request,
      model: 'gpt-6-luna',
      effort: 'none',
    });
    await complete(openai({ baseUrl: 'http://localhost:11434/v1' }), {
      ...request,
      model: 'qwen3',
      effort: 'none',
    });
    await complete(settings(), { ...request, effort: 'none' });
    assert.deepEqual(sent[0].body.reasoning, { effort: 'none' });
    assert.equal(sent[1].body.reasoning_effort, 'none');
    assert.deepEqual(sent[2].body.output_config, { effort: 'low' });
  });

  it('remembers efforts with tools apart, and steps down if a remembered one is refused', async () => {
    // Should a model take tools only at lower efforts, as GPT-6 Luna did on
    // chat completions.
    const toolsRefused = httpError(400, {
      error: {
        message:
          "Function tools with reasoning.effort 'low' are not supported for gpt-6-luna.",
      },
    });
    const sent = capture([
      openAiReply,
      toolsRefused,
      toolsRefused,
      openAiReply,
      openAiReply,
      openAiReply,
    ]);
    const req = {
      model: 'gpt-6-luna',
      system: 'sys',
      messages: [{ role: 'user' as const, text: 'hi' }],
      tools: [],
      maxTokens: 800,
      effort: 'low' as const,
    };
    // Without tools, low is taken and remembered…
    await complete(openai(), {
      ...request,
      model: 'gpt-6-luna',
      effort: 'low',
    });
    // …which doesn't stop a conversation with tools stepping down to none.
    await converse(openai(), req);
    await converse(openai(), req);
    await complete(openai(), {
      ...request,
      model: 'gpt-6-luna',
      effort: 'low',
    });
    assert.deepEqual(sent.map(effortOf), [
      'low',
      'low',
      'minimal',
      'none',
      'none',
      'low',
    ]);
  });
});
