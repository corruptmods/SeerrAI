import { KeyMap } from '@server/lib/notifications/agents/webhook';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// The webhook settings page links to this guide for the template variables.
const GUIDE = path.join(
  __dirname,
  '../../../../docs/using-seerr/notifications/webhook.md'
);

describe('webhook guide', () => {
  it('documents every template variable', () => {
    const guide = readFileSync(GUIDE, 'utf8');
    const missing = Object.keys(KeyMap).filter(
      (key) => !guide.includes(`\`{{${key}}}\``)
    );
    assert.deepEqual(missing, []);
  });

  it('has the section the settings page links to', () => {
    const guide = readFileSync(GUIDE, 'utf8');
    // GitHub names the heading's anchor #template-variables.
    assert.match(guide, /^## Template Variables$/m);
  });
});
