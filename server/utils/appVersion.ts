import logger from '@server/logger';
import { existsSync } from 'fs';
import path from 'path';

const COMMIT_TAG_PATH = path.join(__dirname, '../../committag.json');
let commitTag = 'local';

if (existsSync(COMMIT_TAG_PATH)) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  commitTag = require(COMMIT_TAG_PATH).commitTag;
  logger.info(`Commit Tag: ${commitTag}`);
}

export const getCommitTag = (): string => {
  return commitTag;
};

export const getAppVersion = (): string => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { version } = require('../../package.json');

  let finalVersion = version;

  if (version === '0.1.0') {
    finalVersion = `develop-${getCommitTag()}`;
  }

  return finalVersion;
};

/**
 * Where a development build stands against its branch's newest commits
 * (newest first). build.sh tags builds with the short commit hash, the
 * release workflow with the full one, so either matches. commitsBehind is
 * -1 when this build's commit isn't among them.
 */
export const devBuildStatus = (
  shas: string[],
  commitTag: string
): { updateAvailable: boolean; commitsBehind: number } => {
  const isThisBuild = (sha: string) =>
    commitTag.length >= 7 && sha.startsWith(commitTag);
  if (!shas.length || isThisBuild(shas[0])) {
    return { updateAvailable: false, commitsBehind: 0 };
  }
  return { updateAvailable: true, commitsBehind: shas.findIndex(isThisBuild) };
};
