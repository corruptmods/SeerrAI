/**
 * Headers for every api.github.com request. GitHub answers a request with no
 * version header as 2022-11-28; naming the version keeps the answer fixed
 * until it is moved on purpose. 2026-03-10's breaking changes touch none of
 * the endpoints Seerr AI calls (releases, commits, compare, git trees).
 */
export const GITHUB_API_VERSION = '2026-03-10';

export const GITHUB_API_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': GITHUB_API_VERSION,
} as const;
