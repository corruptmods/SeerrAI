import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import axios, { AxiosError } from 'axios';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { retryWithFreshCsrfToken } from './csrfRetry';

/** A client whose server answers from a list, noting what was asked. */
const clientAnswering = (
  answer: (config: InternalAxiosRequestConfig) => [number, object]
) => {
  const asked: string[] = [];
  const client = axios.create();
  client.defaults.adapter = async (config) => {
    asked.push(`${config.method?.toUpperCase()} ${config.url}`);
    const [status, data] = answer(config);
    const response = {
      data,
      status,
      statusText: '',
      headers: {},
      config,
      request: {},
    } as AxiosResponse;
    if (status >= 400) {
      throw new AxiosError('failed', undefined, config, {}, response);
    }
    return response;
  };
  retryWithFreshCsrfToken(client);
  return { client, asked };
};

describe('a change refused for its CSRF token', () => {
  it('is sent once more after the page gets a fresh token', async () => {
    let refused = false;
    const { client, asked } = clientAnswering((config) => {
      if (config.method === 'post' && !refused) {
        refused = true;
        return [403, { message: 'invalid csrf token' }];
      }
      return [200, { ok: true }];
    });

    const res = await client.post('/api/v1/settings/main', {});
    assert.equal(res.status, 200);
    assert.deepEqual(asked, [
      'POST /api/v1/settings/main',
      'GET /api/v1/status?checkUpdateAvailable=false',
      'POST /api/v1/settings/main',
    ]);
  });

  it('is not sent again a second time, nor for another refusal', async () => {
    const csrf = clientAnswering((config) =>
      config.method === 'post'
        ? [403, { message: 'invalid csrf token' }]
        : [200, {}]
    );
    await assert.rejects(csrf.client.post('/api/v1/settings/main', {}));
    assert.equal(csrf.asked.filter((a) => a.startsWith('POST')).length, 2);

    const other = clientAnswering(() => [403, { message: 'Forbidden' }]);
    await assert.rejects(other.client.post('/api/v1/settings/main', {}));
    assert.deepEqual(other.asked, ['POST /api/v1/settings/main']);
  });
});
