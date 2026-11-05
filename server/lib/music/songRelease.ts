import { musicBrainz } from '@server/api/musicbrainz';
import type LidarrAPI from '@server/api/servarr/lidarr';
import type { LidarrRelease } from '@server/api/servarr/lidarr';

/*
 * Picks the album release songs are imported into. Lidarr tracks each
 * release separately and its own pick can be any edition (e.g. a 49-track
 * bootleg box of a 13-track album), so songs go into a release that has
 * those recordings; the import makes Lidarr monitor it.
 *
 * Never save the album itself to switch releases: saving via the API makes
 * Lidarr forget it was added by hand, and the next artist refresh removes it
 * if the metadata profile excludes it (singles and live albums by default).
 *
 * Prefers the edition most like the download: official, the usual official
 * track count, digital before discs.
 */

/** Release ids per recording MusicBrainz id. */
export type RecordingReleases = Map<string, Set<string>>;

const isOfficial = (release: LidarrRelease) =>
  (release.status ?? '').toLowerCase() === 'official';

/**
 * The release with the most of these recordings, ranked as above. Undefined
 * when none has any.
 */
export const bestRelease = (
  releases: LidarrRelease[],
  recordings: RecordingReleases
): LidarrRelease | undefined => {
  const holds = (release: LidarrRelease) =>
    [...recordings.values()].filter((ids) => ids.has(release.foreignReleaseId))
      .length;
  const most = Math.max(0, ...releases.map(holds));
  if (!most) return undefined;
  const candidates = releases.filter((release) => holds(release) === most);

  // Most common track count among official releases.
  const counts = new Map<number, number>();
  for (const release of candidates.filter(isOfficial)) {
    const n = release.trackCount ?? 0;
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const usual = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0] - b[0]
  )[0]?.[0];

  const rank = (release: LidarrRelease): number[] => [
    isOfficial(release) ? 0 : 1,
    release.trackCount === usual ? 0 : 1,
    /digital/i.test(release.format ?? '') ? 0 : 1,
    release.country?.includes('[Worldwide]') ? 0 : 1,
    release.trackCount ?? Number.MAX_SAFE_INTEGER,
    // On a tie, keep Lidarr's current release.
    release.monitored ? 0 : 1,
  ];
  return [...candidates].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    const i = ra.findIndex((v, k) => v !== rb[k]);
    return i < 0 ? 0 : ra[i] - rb[i];
  })[0];
};

/** Releases each recording appears on, from MusicBrainz. */
export const recordingReleases = async (
  recordingMbids: string[]
): Promise<RecordingReleases> => {
  const mb = musicBrainz();
  const found: RecordingReleases = new Map();
  for (const id of new Set(recordingMbids)) {
    const recording = await mb.getRecording(id, 'background');
    found.set(id, new Set((recording?.releases ?? []).map((r) => r.id)));
  }
  return found;
};

/**
 * The release to import these songs into: Lidarr's monitored one if the
 * album has files (switching would orphan them), else the best match.
 * Undefined until Lidarr lists the album's releases.
 */
export const releaseForSongs = async (
  lidarr: LidarrAPI,
  lidarrAlbumId: number,
  recordingMbids: string[]
): Promise<LidarrRelease | undefined> => {
  const album = await lidarr.getAlbum(lidarrAlbumId);
  const releases = album.releases ?? [];
  if (!releases.length) return undefined;
  const monitored =
    releases.find((release) => release.monitored) ?? releases[0];
  if ((album.statistics?.trackFileCount ?? 0) > 0) return monitored;
  return (
    bestRelease(releases, await recordingReleases(recordingMbids)) ?? monitored
  );
};
