import {
  isCurrentRelease,
  latestRelease,
  releaseUpdateAvailable,
  releaseVersion,
} from '@server/utils/releases';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * GitHub lists releases newest first, pre-releases and (for the owner)
 * drafts included. A stable install read the newest entry as the latest,
 * so publishing a pre-release told everyone on a stable version to update,
 * and a version was matched as part of a title, so 1.2.1 counted as
 * running 1.2.10.
 */

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
