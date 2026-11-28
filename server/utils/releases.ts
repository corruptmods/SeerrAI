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
 * A release's version: its tag without "ai-v" (ai-v2026.11.28 is 2026.11.28),
 * or for other tags, the last word of its title ("Seerr AI 2026.11.28").
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
 * pre-releases only when running one (a version with a "-", like
 * 2026.11.28-beta.1).
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

interface ParsedVersion {
  numbers: number[];
  preRelease: string[];
}

// Releases were 1.2.3 up to 2.5.0, and are named by date since: 2026.11.28,
// and 2026.11.28.1 for a second release that day. Both read as three or four
// numbers, so one comparison covers both, and a date (its year first) is
// always newer than any of the old versions. A "-" starts a pre-release
// (2026.11.28-beta.1), older than the release of the same numbers.
const VERSION_PATTERN =
  /^v?(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/;

const parseVersion = (version: string): ParsedVersion | undefined => {
  const match = VERSION_PATTERN.exec(version.trim());
  if (!match) {
    return undefined;
  }
  return {
    numbers: match.slice(1, 5).map((part) => Number(part ?? 0)),
    preRelease: match[5]?.split('.') ?? [],
  };
};

// As semver orders pre-releases: number parts by value and below words, words
// alphabetically, and a shorter list first when one starts the other.
const comparePreRelease = (a: string[], b: string[]): number => {
  if (!a.length || !b.length) {
    // No pre-release part is the release itself, newer than its betas.
    return Math.sign(b.length - a.length);
  }
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined || b[i] === undefined) {
      return a[i] === undefined ? -1 : 1;
    }
    const aNumber = /^\d+$/.test(a[i]);
    const bNumber = /^\d+$/.test(b[i]);
    if (aNumber && bNumber) {
      const difference = Number(a[i]) - Number(b[i]);
      if (difference) {
        return Math.sign(difference);
      }
    } else if (aNumber !== bNumber) {
      return aNumber ? -1 : 1;
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
};

/**
 * Compares two release versions, old (2.5.0) or by date (2026.11.28,
 * 2026.11.28.1, 2026.11.28-beta.1): below 0 when a is older, above 0 when
 * newer, 0 when the same. undefined when either isn't a release version
 * (such as develop-<commit>).
 */
export const compareVersions = (a: string, b: string): number | undefined => {
  const first = parseVersion(a);
  const second = parseVersion(b);
  if (!first || !second) {
    return undefined;
  }
  for (let i = 0; i < first.numbers.length; i++) {
    const difference = first.numbers[i] - second.numbers[i];
    if (difference) {
      return Math.sign(difference);
    }
  }
  return comparePreRelease(first.preRelease, second.preRelease);
};

/**
 * Whether the latest release is newer than the running version. Versions that
 * can't be compared count as an update whenever they differ.
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
  const order = compareVersions(latestVersion, currentVersion);
  return order === undefined ? latestVersion !== currentVersion : order > 0;
};
