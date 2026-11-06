import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import type { MediaRequest } from '@server/entity/MediaRequest';
import UsedActionToken from '@server/entity/UsedActionToken';
import {
  ACTION_TOKEN_LIFETIME_MS,
  requestFingerprint,
  signActionToken,
  spendActionToken,
  verifyActionToken,
} from '@server/lib/requestActionTokens';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

setupTestDb();

const claims = {
  requestId: 42,
  action: 'approve',
  userId: 1,
  agent: 'ntfy',
  requestState: 'AAAAAAAAAAAAAAAAAAAAAA',
} as const;

/** The token with its body rewritten, keeping the old signature. */
const withBody = (token: string, change: (body: object) => object) => {
  const [body, signature] = token.split('.');
  const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  return `${Buffer.from(JSON.stringify(change(decoded))).toString(
    'base64url'
  )}.${signature}`;
};

describe('notification button tokens', () => {
  it('carry the request, action and account they were made for', () => {
    const now = Date.now();
    const verified = verifyActionToken(signActionToken(claims, now), now);

    assert.ok(verified);
    assert.equal(verified.requestId, 42);
    assert.equal(verified.action, 'approve');
    assert.equal(verified.userId, 1);
    assert.equal(verified.agent, 'ntfy');
    assert.equal(verified.expiresAt, now + ACTION_TOKEN_LIFETIME_MS);
    assert.match(verified.id, /^[0-9a-f]{32}$/);
  });

  it('are each different, even for the same button', () => {
    assert.notEqual(signActionToken(claims), signActionToken(claims));
  });

  it('stop working after seven days', () => {
    const now = Date.now();
    const token = signActionToken(claims, now);
    const week = 7 * 24 * 60 * 60 * 1000;

    assert.ok(verifyActionToken(token, now + week - 1));
    assert.equal(verifyActionToken(token, now + week), undefined);
  });

  it('are refused once anything in them is changed', () => {
    const token = signActionToken(claims);

    for (const change of [
      (body: object) => ({ ...body, r: 43 }),
      (body: object) => ({ ...body, a: 'decline' }),
      (body: object) => ({ ...body, u: 2 }),
      (body: object) => ({ ...body, s: 'BBBBBBBBBBBBBBBBBBBBBB' }),
      (body: object) => ({
        ...body,
        e: Date.now() + 10 * ACTION_TOKEN_LIFETIME_MS,
      }),
    ]) {
      assert.equal(verifyActionToken(withBody(token, change)), undefined);
    }

    const [body, signature] = token.split('.');
    const flipped = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
    assert.equal(verifyActionToken(`${body}.${flipped}`), undefined);
    assert.equal(verifyActionToken(`${body}.`), undefined);
    assert.equal(verifyActionToken(`${token}.extra`), undefined);
  });

  it('are refused when signed with another server’s secret', () => {
    const settings = getSettings() as unknown as {
      data: { sessionSecret: string };
    };
    const saved = settings.data.sessionSecret;
    settings.data.sessionSecret = 'another-servers-secret';
    let foreign: string;
    try {
      foreign = signActionToken(claims);
    } finally {
      settings.data.sessionSecret = saved;
    }

    assert.equal(verifyActionToken(foreign), undefined);
  });

  it('are refused when not tokens at all', () => {
    for (const junk of [
      undefined,
      null,
      42,
      '',
      'nonsense',
      'a.b',
      'x'.repeat(10_000),
      { token: 'a.b' },
    ]) {
      assert.equal(verifyActionToken(junk), undefined);
    }
  });

  it('work once: the second use is refused', async () => {
    const verified = verifyActionToken(signActionToken(claims))!;

    assert.equal(await spendActionToken(verified), true);
    assert.equal(await spendActionToken(verified), false);
    assert.equal(
      await getRepository(UsedActionToken).count({
        where: { id: verified.id },
      }),
      1
    );
  });

  it('forget used tokens once they would have expired anyway', async () => {
    const now = Date.now();
    const old = verifyActionToken(
      signActionToken(claims, now - ACTION_TOKEN_LIFETIME_MS + 1000),
      now
    )!;
    await spendActionToken(old, now);

    const fresh = verifyActionToken(signActionToken(claims, now), now)!;
    await spendActionToken(fresh, now + 2000);

    const kept = await getRepository(UsedActionToken).find();
    assert.deepEqual(
      kept.map((row) => row.id),
      [fresh.id]
    );
  });
});

describe('a request’s fingerprint', () => {
  const base = {
    type: MediaType.TV,
    is4k: false,
    serverId: 1,
    profileId: 4,
    rootFolder: '/tv',
    languageProfileId: 1,
    metadataProfileId: null,
    seriesType: null,
    tags: [2, 1],
    seasons: [{ seasonNumber: 2 }, { seasonNumber: 1 }],
    albums: [],
    songs: [],
  } as unknown as MediaRequest;

  it('is the same whatever order seasons and tags come in', () => {
    assert.equal(
      requestFingerprint(base),
      requestFingerprint({
        ...base,
        tags: [1, 2],
        seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }],
      } as unknown as MediaRequest)
    );
  });

  it('changes with anything an edit can change', () => {
    for (const edit of [
      { is4k: true },
      { serverId: 2 },
      { profileId: 5 },
      { rootFolder: '/anime' },
      { languageProfileId: 2 },
      { tags: [1] },
      { seasons: [{ seasonNumber: 1 }] },
    ]) {
      assert.notEqual(
        requestFingerprint({ ...base, ...edit } as unknown as MediaRequest),
        requestFingerprint(base),
        JSON.stringify(edit)
      );
    }
  });
});
