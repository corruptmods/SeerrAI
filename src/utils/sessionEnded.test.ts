import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import sessionEnded from './sessionEnded';

const user = { id: 1 };
const failed = (status?: number) =>
  Object.assign(new Error('Request failed'), {
    isAxiosError: true,
    response: status === undefined ? undefined : { status },
  });

describe('sessionEnded', () => {
  it('ends the session when the server says nobody is signed in', () => {
    assert.equal(sessionEnded(user, failed(403)), true);
    assert.equal(sessionEnded(user, failed(401)), true);
  });

  it('ends it when there was never anyone signed in', () => {
    assert.equal(sessionEnded(undefined, undefined), true);
  });

  it('keeps the session through a server or network failure', () => {
    // A deploy, a proxy answering 502, the phone between networks.
    assert.equal(sessionEnded(user, failed(502)), false);
    assert.equal(sessionEnded(user, failed(500)), false);
    assert.equal(sessionEnded(user, failed()), false);
    assert.equal(sessionEnded(undefined, failed()), false);
  });

  it('keeps a session that is fine', () => {
    assert.equal(sessionEnded(user, undefined), false);
  });
});
