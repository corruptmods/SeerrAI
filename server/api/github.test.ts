import ExternalAPI from '@server/api/externalapi';
import GithubAPI, { forgetGithubFailures } from '@server/api/github';
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

  it('keeps what GitHub sent for six hours, not five minutes', async (t) => {
    const get = mock.method(
      ExternalAPI.prototype as unknown as {
        get: (path: string, config: unknown, ttl?: number) => Promise<unknown>;
      },
      'get',
      async () => []
    );
    t.after(() => get.mock.restore());

    await new GithubAPI().getSeerrReleases();

    assert.equal(get.mock.calls[0].arguments[2], 6 * 60 * 60);
  });
});

describe('GitHub failing', () => {
  it('is not asked again for a while, then is', async (t) => {
    forgetGithubFailures();
    let failing = true;
    const get = mock.method(
      ExternalAPI.prototype as unknown as {
        get: (path: string, config: unknown) => Promise<unknown>;
      },
      'get',
      async () => {
        if (failing) throw new Error('GitHub refused');
        return [];
      }
    );
    t.after(() => {
      get.mock.restore();
      mock.timers.reset();
    });
    mock.timers.enable({ apis: ['Date'], now: 1_000_000 });

    const github = new GithubAPI();
    assert.deepEqual(await github.getSeerrReleases(), []);
    assert.deepEqual(await github.getSeerrReleases(), []);
    assert.equal(get.mock.callCount(), 1);

    failing = false;
    mock.timers.tick(5 * 60 * 1000);
    await github.getSeerrReleases();
    assert.equal(get.mock.callCount(), 2);
  });

  it('is given up on after a while', () => {
    const timeout = (
      new GithubAPI() as unknown as {
        axios: { defaults: { timeout?: number } };
      }
    ).axios.defaults.timeout;
    assert.ok(timeout && timeout > 0);
  });
});
