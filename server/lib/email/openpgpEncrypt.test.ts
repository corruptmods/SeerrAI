import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { openpgpEncrypt } from '@server/lib/email/openpgpEncrypt';

describe('openpgpEncrypt', () => {
  it('sends unencrypted, calling back once, when there are no keys', async () => {
    let transforms = 0;
    let calls = 0;
    const mail = { message: { transform: () => transforms++ } };
    openpgpEncrypt({ encryptionKeys: [] } as never)(mail, () => calls++);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(transforms, 0);
  });
});
