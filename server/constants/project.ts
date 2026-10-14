/*
 * Where Seerr AI lives on GitHub: its releases and commits are what "up to
 * date" is checked against, and what the About page links to. Change this
 * if the repository is renamed or moved: GitHub redirects an old name only
 * until another repository takes it.
 */
export const PROJECT_NAME = 'Seerr AI';
export const PROJECT_REPO = 'corruptmods/SeerrAI';
/** Releases are cut from this branch; the guide links point at it. */
export const PROJECT_BRANCH = 'main';
/**
 * Work lands here first. A build that is not a release (version
 * "develop-<commit>": the NAS's own build.sh, :develop or a :preview-…
 * image) checks for updates against this branch's commits.
 */
export const PROJECT_DEV_BRANCH = 'dev';
export const PROJECT_URL = `https://github.com/${PROJECT_REPO}`;
/** The guide to what Seerr AI adds, in the repository. */
export const PROJECT_DOCS_URL = `${PROJECT_URL}/blob/${PROJECT_BRANCH}/docs/seerr-ai/README.md`;
