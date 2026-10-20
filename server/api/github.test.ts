import ExternalAPI from '@server/api/externalapi';
import GithubAPI from '@server/api/github';
import { PROJECT_DEV_BRANCH } from '@server/constants/project';
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

describe('GitHub commits', () => {
  it('asks for the branch it was given', async (t) => {
    const get = mock.method(
      ExternalAPI.prototype as unknown as {
        get: (path: string, config: unknown) => Promise<unknown>;
      },
      'get',
      async () => []
    );
    t.after(() => get.mock.restore());

    await new GithubAPI().getSeerrCommits({ branch: PROJECT_DEV_BRANCH });

    const [path, config] = get.mock.calls[0].arguments as [
      string,
      { params: Record<string, unknown> },
    ];
    assert.match(path, /\/commits$/);
    assert.equal(config.params.sha, PROJECT_DEV_BRANCH);
    assert.equal('branch' in config.params, false);
  });
});
