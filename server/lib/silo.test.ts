import SiloAPI from '@server/api/silo/client';
import { siloCheck } from '@server/lib/health';
import { siloVersionQuality } from '@server/lib/mediaQuality';
import { getSettings, siloDefaults } from '@server/lib/settings';
import {
  isSilo4k,
  recordSiloInfo,
  siloLibraries,
  siloLibraryType,
} from '@server/lib/silo';
import { createFakeSilo } from '@server/test/fakeSilo';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

const silo = createFakeSilo();
const client = (key = 'sa_test') =>
  new SiloAPI(`http://127.0.0.1:${silo.port()}`, key);

before(() => silo.start());
after(() => silo.stop());
beforeEach(() => {
  silo.reset();
  getSettings().silo = siloDefaults();
});

describe('Silo libraries and files in Seerr AI', () => {
  it("maps Silo's free-text library types, leaving books and the like out", () => {
    assert.equal(siloLibraryType('Movies'), 'movie');
    assert.equal(siloLibraryType(' tv '), 'show');
    assert.equal(siloLibraryType('series'), 'show');
    assert.equal(siloLibraryType('mixed'), 'mixed');
    assert.equal(siloLibraryType('audiobooks'), undefined);
    assert.equal(siloLibraryType('podcasts'), undefined);
    assert.equal(siloLibraryType('manga'), undefined);
    assert.equal(siloLibraryType('ebooks'), undefined);
  });

  it('keeps each library switch when read again', () => {
    const libraries = siloLibraries(
      [
        { id: '7', name: 'Films', type: 'movies', sort_order: 1 },
        { id: '8', name: 'Books', type: 'ebooks', sort_order: 0 },
      ],
      [{ id: '7', name: 'Old name', enabled: true, type: 'movie', lastScan: 3 }]
    );
    assert.deepEqual(libraries, [
      { id: '7', name: 'Films', enabled: true, type: 'movie', lastScan: 3 },
    ]);
  });

  it('reads resolution and HDR from a file', () => {
    assert.equal(isSilo4k({ resolution: '2160p' }), true);
    assert.equal(isSilo4k({ resolution: '4320p' }), true);
    assert.equal(isSilo4k({ resolution: '4k' }), true);
    assert.equal(isSilo4k({ resolution: '1080p' }), false);
    assert.equal(isSilo4k({}), false);
    assert.deepEqual(
      siloVersionQuality({ resolution: '2160p', dynamic_range: 'hdr10_plus' }),
      { resolutions: ['4K'], ranges: ['HDR10+'] }
    );
    assert.deepEqual(
      siloVersionQuality({ resolution: '720p', dynamic_range: 'sdr' }),
      { resolutions: ['720p'], ranges: [] }
    );
    assert.deepEqual(siloVersionQuality({ resolution: '480p' }), {
      resolutions: ['SD'],
    });
    assert.deepEqual(
      siloVersionQuality({ resolution: '1080p', dynamic_range: 'hdr_unknown' }),
      { resolutions: ['1080p'] }
    );
    assert.deepEqual(
      siloVersionQuality({ resolution: '1080p', dynamic_range: 'hdr12' }),
      { resolutions: ['1080p'] },
      'a range Silo adds later'
    );
    assert.equal(siloVersionQuality({}), undefined);
  });

  it('remembers the build and contract Silo reports', async () => {
    const info = await client().getSystemInfo();
    await recordSiloInfo(info);
    assert.equal(getSettings().silo.serverVersion, '1.0.0');
    assert.equal(getSettings().silo.contractDigest, 'a'.repeat(64));
  });
});

describe('the Silo health check', () => {
  it('shows the version, and what Silo reports wrong', async () => {
    let check = await siloCheck(client());
    assert.equal(check.status, 'ok');
    assert.match(check.detail ?? '', /Silo 1\.0\.0, API v2/);

    silo.status = {
      ...silo.status,
      restart_required: true,
      restart_required_reason: 'Hardware decoding changed',
      health: { ...silo.status.health, redis: { configured: true, ok: false } },
    };
    check = await siloCheck(client());
    assert.equal(check.status, 'error');
    assert.deepEqual(
      check.items.map((item) => item.title),
      ['Silo needs a restart', "Silo can't reach its cache"]
    );
  });

  it('says why it failed', async () => {
    let check = await siloCheck(client('sa_wrong'));
    assert.equal(check.status, 'error');
    assert.equal(
      check.detail,
      'Silo did not accept the API key (Settings → Silo).'
    );
    silo.apiMajor = 3;
    check = await siloCheck(client());
    assert.equal(
      check.detail,
      'This Silo speaks API v3; Seerr AI supports v2.'
    );
  });
});
