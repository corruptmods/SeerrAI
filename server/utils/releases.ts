import semverGt from 'semver/functions/gt';
import semverValid from 'semver/functions/valid';

// Picks the latest Seerr AI GitHub release for an install and whether it's
// newer than the running version. Shared by the server's update check and
// Settings → About's release list, so they never disagree.

/** The fields these checks need from a GitHub release. */
export interface ReleaseSummary {
  tag_name: string;
  name: string | null;
  draft?: boolean;
  prerelease?: boolean;
}

/**
 * A release's version: its tag without "ai-v" (ai-v1.2.3 is 1.2.3), or for
 * other tags, the last word of its title ("Seerr AI 1.2.3").
 */
export const releaseVersion = (release: ReleaseSummary): string => {
  if (release.tag_name.startsWith('ai-v')) {
    return release.tag_name.slice('ai-v'.length);
  }
  const words = (release.name ?? release.tag_name).trim().split(/\s+/);
  return (words[words.length - 1] ?? '').replace(/^v/, '');
};

/** Whether a release is of exactly this version. */
export const isCurrentRelease = (
  release: ReleaseSummary,
  currentVersion: string
): boolean => releaseVersion(release) === currentVersion;

/**
 * The newest published release for this version's install: never drafts, and
 * pre-releases only when running one (a version with a "-", like 1.3.0-beta.1).
 * GitHub lists newest first.
 */
export const latestRelease = <T extends ReleaseSummary>(
  releases: T[],
  currentVersion: string
): T | undefined => {
  const onPreRelease = currentVersion.includes('-');
  return releases.find(
    (release) => !release.draft && (onPreRelease || !release.prerelease)
  );
};

/**
 * Whether the latest release is newer than the running version. Versions that
 * can't be compared numerically count as an update whenever they differ.
 */
export const releaseUpdateAvailable = (
  releases: ReleaseSummary[],
  currentVersion: string
): boolean => {
  const latest = latestRelease(releases, currentVersion);
  if (!latest) {
    return false;
  }
  const latestVersion = releaseVersion(latest);
  if (semverValid(latestVersion) && semverValid(currentVersion)) {
    return semverGt(latestVersion, currentVersion);
  }
  return latestVersion !== currentVersion;
};
