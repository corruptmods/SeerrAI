import { PROJECT_BRANCH, PROJECT_REPO } from '@server/constants/project';
import cacheManager from '@server/lib/cache';
import logger from '@server/logger';
import ExternalAPI, { DEFAULT_REQUEST_TIMEOUT_MS } from './externalapi';

/** After GitHub fails, how long until it is asked again. */
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;

/** When each GitHub list last failed, by endpoint and parameters. */
const failedAt = new Map<string, number>();

interface GitHubRelease {
  url: string;
  assets_url: string;
  upload_url: string;
  html_url: string;
  id: number;
  node_id: string;
  tag_name: string;
  target_commitish: string;
  name: string;
  draft: boolean;
  prerelease: boolean;
  created_at: string;
  published_at: string;
  tarball_url: string;
  zipball_url: string;
  body: string;
}

interface GithubCommit {
  sha: string;
  node_id: string;
  commit: {
    author: {
      name: string;
      email: string;
      date: string;
    };
    committer: {
      name: string;
      email: string;
      date: string;
    };
    message: string;
    tree: {
      sha: string;
      url: string;
    };
    url: string;
    comment_count: number;
    verification: {
      verified: boolean;
      reason: string;
      signature: string;
      payload: string;
    };
  };
  url: string;
  html_url: string;
  comments_url: string;
  parents: [
    {
      sha: string;
      url: string;
      html_url: string;
    },
  ];
}

class GithubAPI extends ExternalAPI {
  constructor() {
    super(
      'https://api.github.com',
      {},
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        nodeCache: cacheManager.getCache('github').data,
        timeout: DEFAULT_REQUEST_TIMEOUT_MS,
      }
    );
  }

  /**
   * A list from GitHub, or none when GitHub fails; after a failure, none
   * without asking for a while.
   */
  private async listOrNone<T>(
    endpoint: string,
    params: Record<string, unknown>,
    failure: string
  ): Promise<T[]> {
    const key = `${endpoint}${JSON.stringify(params)}`;
    const failed = failedAt.get(key);
    if (failed !== undefined && Date.now() - failed < RETRY_AFTER_FAILURE_MS) {
      return [];
    }
    try {
      const data = await this.get<T[]>(endpoint, { params });
      failedAt.delete(key);
      return data;
    } catch (e) {
      failedAt.set(key, Date.now());
      logger.warn(failure, { label: 'GitHub API', errorMessage: e.message });
      return [];
    }
  }

  public async getSeerrReleases({
    take = 20,
  }: {
    take?: number;
  } = {}): Promise<GitHubRelease[]> {
    return this.listOrNone<GitHubRelease>(
      `/repos/${PROJECT_REPO}/releases`,
      { per_page: take },
      "Failed to retrieve GitHub releases. This may be an issue on GitHub's end. Seerr AI can't check if it's on the latest version."
    );
  }

  public async getSeerrCommits({
    take = 20,
    branch = PROJECT_BRANCH,
  }: {
    take?: number;
    branch?: string;
  } = {}): Promise<GithubCommit[]> {
    // GitHub selects the branch by "sha"; "branch" is ignored and lists the
    // default branch.
    return this.listOrNone<GithubCommit>(
      `/repos/${PROJECT_REPO}/commits`,
      { per_page: take, sha: branch },
      "Failed to retrieve GitHub commits. This may be an issue on GitHub's end. Seerr AI can't check if it's on the latest version."
    );
  }
}

/** Forgets GitHub failures, so the next check asks again. */
export const forgetGithubFailures = (): void => failedAt.clear();

export default GithubAPI;
