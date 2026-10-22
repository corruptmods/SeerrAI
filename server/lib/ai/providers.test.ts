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
 * What is actually sent to each API: the smallest request it accepts, and
 * the right shape for each kind of model.
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

  it('uses its newer options on its own API, with JSON enforced when asked', async () => {
    const sent = capture([reply('{"a":1}')]);
    await complete(openai(), { ...request, model: 'gpt-4.1-mini', json: true });

    assert.equal(sent[0].url, `${OPENAI_URL}/chat/completions`);
    assert.deepEqual(sent[0].body, {
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'developer', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
      max_completion_tokens: 100,
      response_format: { type: 'json_object' },
    });
    assert.equal(sent[0].headers.authorization, 'Bearer test-key');
  });

  it('asks reasoning models for the least effort each accepts, and remembers it', async () => {
    const effortRefused = (value: string) =>
      httpError(400, {
        error: {
          message: `Unsupported value: 'reasoning_effort' does not support '${value}' with this model.`,
        },
      });
    const sent = capture([
      effortRefused('none'),
      effortRefused('minimal'),
      reply('ok'),
      reply('again'),
    ]);
    await complete(openai(), { ...request, model: 'gpt-6-luna' });
    await complete(openai(), { ...request, model: 'gpt-6-luna' });
    assert.deepEqual(
      sent.map((s) => s.body.reasoning_effort),
      ['none', 'minimal', 'low', 'low']
    );
    assert.ok((sent[0].body.max_completion_tokens as number) > 100);
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
        error: { message: "'response_format' is not supported" },
      }),
      reply('{}'),
    ]);
    await complete(openai(), { ...request, model: 'gpt-4o', json: true });
    assert.equal(sent.length, 2);
    assert.equal(sent[1].body.response_format, undefined);
    assert.equal(sent[1].body.max_completion_tokens, 100);
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
    capture([reply('', 'length')]);
    await assert.rejects(
      complete(openai(), { ...request, model: 'o3' }),
      /used up its answer length/
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

  it('goes to OpenAI and servers like it as a data URL beside the text', async () => {
    const reply = { choices: [{ message: { content: 'ok' } }] };
    const sent = capture([reply, reply]);
    const openai = settings({ provider: 'openai' });
    await complete(openai, { ...request, model: 'gpt-4.1-mini', image });
    await complete(
      { ...openai, baseUrl: 'http://nas.local:11434/v1' },
      { ...request, image }
    );
    for (const s of sent) {
      assert.deepEqual((s.body.messages as { content: unknown }[])[1].content, [
        { type: 'text', text: 'hi' },
        {
          type: 'image_url',
          image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ' },
        },
      ]);
    }
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
    // The same refusal without a picture is reported as it is.
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

  it('gives OpenAI functions, and reads the arguments it wrote', async () => {
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
    assert.equal(sent[0].url, `${OPENAI_URL}/chat/completions`);
    assert.deepEqual(sent[0].body.tools, [
      {
        type: 'function',
        function: {
          name: 'title_status',
          description: 'What a title has and lacks',
          parameters: tools[0].parameters,
        },
      },
    ]);

    await converse(ai, {
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
    const messages = sent[1].body.messages as Record<string, unknown>[];
    assert.equal(messages[0].role, 'developer');
    assert.deepEqual(messages[2], first.raw);
    assert.deepEqual(messages[3], {
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'Error: not found',
    });
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
