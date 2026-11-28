import {
  compareVersions,
  isCurrentRelease,
  latestRelease,
  releaseUpdateAvailable,
  releaseVersion,
} from '@server/utils/releases';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// GitHub lists releases newest first, including pre-releases and (for the
// owner) drafts. Regressions: a stable install took the newest entry as latest,
// so a pre-release told everyone to update; and versions matched as part of a
// title, so 1.2.1 counted as running 1.2.10.

const release = (
  version: string,
  { prerelease = false, draft = false } = {}
) => ({
  tag_name: `ai-v${version}`,
  name: `Seerr AI ${version}`,
  prerelease,
  draft,
});

const releases = [
  release('1.4.0', { draft: true }),
  release('1.3.0-beta.1', { prerelease: true }),
  release('1.2.10'),
  release('1.2.1'),
];

describe('release versions', () => {
  it('reads the version from the tag', () => {
    assert.equal(releaseVersion(release('1.2.10')), '1.2.10');
  });

  it('falls back to the title when the tag is not ai-v…', () => {
    assert.equal(
      releaseVersion({ tag_name: 'other', name: 'Seerr AI v1.2.3' }),
      '1.2.3'
    );
  });

  it('matches a version exactly, not as part of another', () => {
    assert.equal(isCurrentRelease(release('1.2.10'), '1.2.1'), false);
    assert.equal(isCurrentRelease(release('1.2.1'), '1.2.1'), true);
  });
});

describe('latest release', () => {
  it('skips pre-releases and drafts for a stable install', () => {
    assert.equal(latestRelease(releases, '1.2.1')?.tag_name, 'ai-v1.2.10');
  });

  it('counts pre-releases, not drafts, for a pre-release install', () => {
    assert.equal(
      latestRelease(releases, '1.3.0-beta.1')?.tag_name,
      'ai-v1.3.0-beta.1'
    );
  });

  it('is nothing when there is no published release', () => {
    assert.equal(
      latestRelease([release('1.0.0', { draft: true })], '1.0.0'),
      undefined
    );
  });
});

describe('release update check', () => {
  it('does not offer a pre-release to a stable install', () => {
    assert.equal(releaseUpdateAvailable(releases, '1.2.10'), false);
  });

  it('offers a newer stable release', () => {
    assert.equal(releaseUpdateAvailable(releases, '1.2.1'), true);
  });

  it('offers a newer pre-release to a pre-release install', () => {
    assert.equal(
      releaseUpdateAvailable(
        [release('1.3.0-beta.2', { prerelease: true }), ...releases],
        '1.3.0-beta.1'
      ),
      true
    );
  });

  it('offers nothing older than the version running', () => {
    assert.equal(releaseUpdateAvailable(releases, '1.3.0-beta.1'), false);
    assert.equal(releaseUpdateAvailable(releases, '1.2.11'), false);
  });

  it('assumes nothing when GitHub lists no releases', () => {
    assert.equal(releaseUpdateAvailable([], '1.2.1'), false);
  });
});

describe('versions named by date', () => {
  const newer = (a: string, b: string) => {
    assert.equal(compareVersions(a, b), 1, `${a} > ${b}`);
    assert.equal(compareVersions(b, a), -1, `${b} < ${a}`);
  };

  it('puts every date after the old versions', () => {
    newer('2026.11.28', '2.5.0');
    newer('2026.11.28-beta.1', '2.5.0');
  });

  it('orders dates by their numbers, not as text', () => {
    newer('2026.12.1', '2026.11.30');
    newer('2027.1.5', '2026.12.31');
    newer('2026.11.28', '2026.11.9');
  });

  it('puts a second release of a day after the first', () => {
    newer('2026.11.28.1', '2026.11.28');
    newer('2026.11.28.10', '2026.11.28.2');
    newer('2026.11.29', '2026.11.28.3');
  });

  it('puts a beta before the release of its day', () => {
    newer('2026.11.28', '2026.11.28-beta.1');
    newer('2026.11.28-beta.2', '2026.11.28-beta.1');
    newer('2026.11.28-beta.10', '2026.11.28-beta.2');
    newer('2026.11.28.1-beta.1', '2026.11.28');
  });

  it('finds a version equal to itself', () => {
    assert.equal(compareVersions('2026.11.28', '2026.11.28'), 0);
    assert.equal(compareVersions('2026.11.28.1', '2026.11.28.1'), 0);
  });

  it("can't compare a development build", () => {
    assert.equal(compareVersions('develop-f7f224c', '2026.11.28'), undefined);
    assert.equal(compareVersions('2026.11.28', 'local'), undefined);
  });

  it('offers a release by date to an install on the old versions', () => {
    assert.equal(
      releaseUpdateAvailable([release('2026.11.28')], '2.5.0'),
      true
    );
  });

  it("offers a day's second release, and nothing older", () => {
    const list = [release('2026.11.28.1'), release('2026.11.28')];
    assert.equal(releaseUpdateAvailable(list, '2026.11.28'), true);
    assert.equal(releaseUpdateAvailable(list, '2026.11.28.1'), false);
    assert.equal(releaseUpdateAvailable(list, '2026.12.1'), false);
  });

  it('offers the release to an install on its beta', () => {
    assert.equal(
      releaseUpdateAvailable(
        [
          release('2026.11.28'),
          release('2026.11.28-beta.1', { prerelease: true }),
        ],
        '2026.11.28-beta.1'
      ),
      true
    );
  });

  it('matches a version exactly, not as part of a longer one', () => {
    assert.equal(
      isCurrentRelease(release('2026.11.28.1'), '2026.11.28'),
      false
    );
    assert.equal(isCurrentRelease(release('2026.11.28'), '2026.11.28'), true);
  });
});
