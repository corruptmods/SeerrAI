import { musicBrainz } from '@server/api/musicbrainz';
import type LidarrAPI from '@server/api/servarr/lidarr';
import type { LidarrRelease } from '@server/api/servarr/lidarr';

/*
 * Which release of an album songs are taken into. Lidarr lists the tracks
 * of each release of an album apart, and its own pick for the album can be
 * any edition: a 49-track bootleg box of a 13-track album, say. Songs are
 * imported into the tracks of a release with those very recordings on it;
 * the import then has Lidarr monitor that release (and stay on it).
 *
 * The album itself is never changed to get there: Lidarr forgets that an
 * album was added by hand when it is saved through its API, and then
 * removes it on the artist's next refresh if its metadata profile leaves
 * such albums out (singles, live albums, by default).
 *
 * The edition most like what is downloaded is picked: official, with the
 * track count most official editions have, digital before discs.
 */

/** Each recording's releases, by MusicBrainz id. */
export type RecordingReleases = Map<string, Set<string>>;

const isOfficial = (release: LidarrRelease) =>
  (release.status ?? '').toLowerCase() === 'official';

/**
 * The best release for these recordings: the one with the most of them,
 * then as above. None when no release has any.
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

  // The usual edition's track count, among the official ones.
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
    // Otherwise as good: the one Lidarr has, so nothing changes.
    release.monitored ? 0 : 1,
  ];
  return [...candidates].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    const i = ra.findIndex((v, k) => v !== rb[k]);
    return i < 0 ? 0 : ra[i] - rb[i];
  })[0];
};

/** The releases each recording is on, from MusicBrainz. */
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
 * The release of an album to take these songs into: the one Lidarr
 * monitors while the album has files of its own (another would leave them
 * behind), else the best with the songs on it. Undefined until Lidarr has
 * listed the album's releases.
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
