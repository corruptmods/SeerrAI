import { SignInLimiter } from '@server/lib/signInLimiter';
import type { Request, Response } from 'express';
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

describe('attempts arriving together', () => {
  /** A response that only needs to accept a 429. */
  const response = () => {
    const res = { set: () => res, status: () => res, json: () => res };
    return res as unknown as Response;
  };

  it('lets only ten through for one account from one address', () => {
    const limiter = new SignInLimiter('test-together');
    const allowed = Array.from({ length: 15 }, () =>
      limiter.take(from('10.0.0.1'), response(), 'glasswing@example.invalid')
    ).filter(Boolean).length;
    assert.equal(allowed, 10);
    assert.ok(
      limiter.retryAfter(from('10.0.0.1'), 'glasswing@example.invalid')
    );
  });

  it('gives back an attempt that turned out no failure', () => {
    const limiter = new SignInLimiter('test-refund');
    for (let i = 0; i < 10; i++) {
      assert.equal(limiter.reserve(from('10.0.0.1'), 'static-garden'), 0);
    }
    assert.ok(limiter.reserve(from('10.0.0.1'), 'static-garden') > 0);
    limiter.refund(from('10.0.0.1'), 'static-garden');
    assert.equal(limiter.reserve(from('10.0.0.1'), 'static-garden'), 0);
    assert.ok(limiter.reserve(from('10.0.0.1'), 'static-garden') > 0);
  });
});

describe('one account tried from many addresses', () => {
  const tryFromFifty = (limiter: SignInLimiter, account: string) => {
    for (let i = 1; i <= 50; i++) {
      limiter.count(from(`192.0.2.${i}`), account);
    }
  };

  it('asks for a wait after fifty failures, when the limiter caps accounts', () => {
    const limiter = new SignInLimiter('test-cap', { capAccount: true });
    tryFromFifty(limiter, 'lantern@example.invalid');
    assert.ok(
      limiter.retryAfter(from('192.0.2.99'), 'Lantern@example.invalid')
    );
    assert.equal(
      limiter.retryAfter(from('192.0.2.99'), 'harbour@example.invalid'),
      0
    );
  });

  it('only counts each address on its own otherwise', () => {
    const limiter = new SignInLimiter('test-no-cap');
    tryFromFifty(limiter, 'lantern@example.invalid');
    assert.equal(
      limiter.retryAfter(from('192.0.2.99'), 'lantern@example.invalid'),
      0
    );
  });

  it('gives a successful sign-in back to the account', () => {
    const limiter = new SignInLimiter('test-cap-clear', { capAccount: true });
    for (let i = 1; i <= 49; i++) {
      limiter.count(from(`192.0.2.${i}`), 'harbour@example.invalid');
    }
    assert.equal(
      limiter.reserve(from('192.0.2.60'), 'harbour@example.invalid'),
      0
    );
    limiter.clear(from('192.0.2.60'), 'harbour@example.invalid');
    assert.equal(
      limiter.retryAfter(from('192.0.2.61'), 'harbour@example.invalid'),
      0
    );
  });
});

describe('counting with many accounts tried at once', () => {
  it('takes about as long per attempt as with few', () => {
    const limiter = new SignInLimiter('test-many');
    const timeCounts = (prefix: string) => {
      const started = process.hrtime.bigint();
      for (let i = 0; i < 2000; i++) {
        limiter.count(from('10.0.0.1'), `${prefix}-${i}`);
      }
      return Number(process.hrtime.bigint() - started);
    };

    const few = timeCounts('few');
    for (let i = 0; i < 50_000; i++) {
      limiter.count(from('10.0.0.2'), `filler-${i}`);
    }
    const many = timeCounts('many');
    assert.ok(many < few * 20, `${many}ns with many, ${few}ns with few`);
  });
});
