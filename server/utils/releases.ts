import semverGt from 'semver/functions/gt';
import semverValid from 'semver/functions/valid';

/*
 * Which of Seerr AI's GitHub releases is the latest for an install, and
 * whether it is newer than the version running. Shared by the update check
 * on the server and the release list in Settings → About, so the two never
 * disagree.
 */

/** What these checks need of a release as GitHub lists it. */
export interface ReleaseSummary {
  tag_name: string;
  name: string | null;
  draft?: boolean;
  prerelease?: boolean;
}

/**
 * The version a release is of: its tag without "ai-v" (ai-v1.2.3 is
 * 1.2.3), or for a tag not made that way, the last word of its title
 * ("Seerr AI 1.2.3").
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
 * The newest published release for an install of this version: drafts
 * never count, and pre-releases only for an install that is running one
 * (a version with a "-", like 1.3.0-beta.1). GitHub lists newest first.
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
 * Whether the latest release is newer than the version running. A version
 * that can't be compared as a version number counts as an update whenever
 * it differs.
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
