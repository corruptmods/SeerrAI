import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatRuleCertifications,
  parseRuleCertifications,
} from './ruleCertification';

describe('the age ratings kept on an override rule', () => {
  it('reads each country and rating', () => {
    assert.deepEqual(parseRuleCertifications('US:PG-13,GB:12A'), [
      { country: 'US', certification: 'PG-13' },
      { country: 'GB', certification: '12A' },
    ]);
  });

  it('reads nothing from an empty or malformed value', () => {
    assert.deepEqual(parseRuleCertifications(null), []);
    assert.deepEqual(parseRuleCertifications(''), []);
    assert.deepEqual(parseRuleCertifications('PG,US:,:R'), []);
  });

  it('writes them back the same way, and nothing as no condition', () => {
    assert.equal(
      formatRuleCertifications(parseRuleCertifications('US:G,DE:12')),
      'US:G,DE:12'
    );
    assert.equal(formatRuleCertifications([]), null);
  });
});
