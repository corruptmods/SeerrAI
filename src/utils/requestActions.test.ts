import { AxiosError, AxiosHeaders } from 'axios';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { oneAfterAnother, requestActionError } from './requestActions';

/** An error as axios gives it for an answer from the server. */
const answered = (status: number, data: unknown) =>
  new AxiosError('Request failed', 'ERR_BAD_REQUEST', undefined, undefined, {
    status,
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
    data,
  });

describe('doing something to several requests', () => {
  it('does one at a time, in order, never two at once', async () => {
    const started: number[] = [];
    let running = 0;
    let mostAtOnce = 0;

    await oneAfterAnother([1, 2, 3], async (id) => {
      started.push(id);
      running++;
      mostAtOnce = Math.max(mostAtOnce, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
    });

    assert.deepEqual(started, [1, 2, 3]);
    assert.equal(mostAtOnce, 1);
  });

  it('carries on past one that fails, and says which failed', async () => {
    const done: number[] = [];
    const failure = new Error('no');

    const errors = await oneAfterAnother([1, 2, 3], async (id) => {
      if (id === 2) {
        throw failure;
      }
      done.push(id);
    });

    assert.deepEqual(done, [1, 3]);
    assert.deepEqual(errors, [failure]);
  });
});

describe('what someone is told when it fails', () => {
  it("is the server's reason, where it gave one", () => {
    assert.equal(
      requestActionError(
        answered(409, {
          message: 'Only pending requests can be approved or declined.',
        }),
        'Something went wrong.'
      ),
      'Only pending requests can be approved or declined.'
    );
  });

  it('is the general message otherwise', () => {
    for (const e of [
      answered(500, {}),
      answered(502, '<html>Bad gateway</html>'),
      answered(409, { message: '  ' }),
      new Error('Network Error'),
      undefined,
    ]) {
      assert.equal(
        requestActionError(e, 'Something went wrong.'),
        'Something went wrong.'
      );
    }
  });
});
