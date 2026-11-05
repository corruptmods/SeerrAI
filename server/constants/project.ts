// Seerr AI's GitHub repository: update checks compare against its releases and
// commits, and the About page links to it. Change this if the repository is
// renamed or moved; GitHub only redirects an old name until another repository
// takes it.
export const PROJECT_NAME = 'Seerr AI';
export const PROJECT_REPO = 'corruptmods/SeerrAI';
/** Releases are cut from this branch; guide links point at it. */
export const PROJECT_BRANCH = 'main';
/**
 * The development branch. Non-release builds (version "develop-<commit>": the
 * NAS's build.sh, :develop or :preview-… images) check for updates against its
 * commits.
 */
export const PROJECT_DEV_BRANCH = 'dev';
export const PROJECT_URL = `https://github.com/${PROJECT_REPO}`;
/** The guide to Seerr AI's additions, in the repository. */
export const PROJECT_DOCS_URL = `${PROJECT_URL}/blob/${PROJECT_BRANCH}/docs/seerr-ai/README.md`;
