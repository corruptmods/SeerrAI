import type { AllSettings } from '@server/lib/settings';
import Settings from '@server/lib/settings';
import migrateNetworkSettings from '@server/lib/settings/migrations/0005_migrate_network_settings';
import keepCsrfSetting from '@server/lib/settings/migrations/0017_keep_csrf_setting';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// CSRF protection: on for a new install, as it was for an existing one.

const run = (settings: unknown) =>
  keepCsrfSetting(
    structuredClone(settings) as unknown as AllSettings
  ) as unknown as { network?: { csrfProtection?: boolean } };

describe('CSRF protection', () => {
  it('is on for a new install', () => {
    assert.equal(new Settings().network.csrfProtection, true);
  });

  it('stays as an existing settings file has it', () => {
    for (const value of [true, false]) {
      assert.equal(
        run({ network: { csrfProtection: value } }).network?.csrfProtection,
        value
      );
    }
  });

  it('stays off for an existing settings file without the switch', () => {
    assert.equal(
      run({ network: { trustProxy: false } }).network?.csrfProtection,
      false
    );
    // Older files, from before network settings had their own section.
    const older = migrateNetworkSettings({ main: {} });
    assert.equal(run(older).network?.csrfProtection, false);
  });
});
