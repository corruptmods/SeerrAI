import { SignInLimiter } from '@server/lib/signInLimiter';
import type { Request } from 'express';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * Wrong passwords count per account and address together, however the account
 * is typed.
 */

const from = (ip: string) => ({ ip }) as Request;

describe('the sign-in limiter', () => {
  it('asks for a wait after ten tries at one account from one address', () => {
    const limiter = new SignInLimiter('test-ten');
    for (let i = 0; i < 10; i++) {
      assert.equal(
        limiter.retryAfter(from('10.0.0.1'), 'Someone@Example.test'),
        0
      );
      limiter.count(from('10.0.0.1'), 'Someone@Example.test');
    }
    // Same account however typed; not from another address, nor another
    // account.
    assert.ok(
      limiter.retryAfter(from('10.0.0.1'), ' someone@example.test ') > 0
    );
    assert.equal(
      limiter.retryAfter(from('10.0.0.2'), 'someone@example.test'),
      0
    );
    assert.equal(limiter.retryAfter(from('10.0.0.1'), 'other@example.test'), 0);

    limiter.clear(from('10.0.0.1'), 'SOMEONE@example.test');
    assert.equal(
      limiter.retryAfter(from('10.0.0.1'), 'someone@example.test'),
      0
    );
  });

  it('counts a very long account name like any other', () => {
    const limiter = new SignInLimiter('test-long');
    const long = 'x'.repeat(100_000);
    for (let i = 0; i < 10; i++) {
      limiter.count(from('10.0.0.1'), long);
    }
    assert.ok(limiter.retryAfter(from('10.0.0.1'), long) > 0);
    assert.equal(limiter.retryAfter(from('10.0.0.1'), `${long}y`), 0);
  });
});
