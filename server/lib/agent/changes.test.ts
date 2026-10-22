import type { ProposedChange } from '@server/lib/agent/changes';
import {
  ChangeError,
  applyChange,
  describeChange,
} from '@server/lib/agent/changes';
import type { ArrEpisode, ArrHistoryRecord } from '@server/lib/autofix/arr';
import { FixRadarr, FixSonarr } from '@server/lib/autofix/arr';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

/*
 * The changes the admin agent proposes: what an admin is shown, and what
 * is done once they approve, checked again against Radarr and Sonarr as
 * they are by then. Both are stand-ins that record what was asked of them.
 */

const GB = 1024 ** 3;
const MOVIE = { kind: 'movie' as const, serverId: 0, arrId: 3541 };
const SERIES = { kind: 'series' as const, serverId: 0, arrId: 77 };

let calls: string[] = [];
let recycleBin = '';
let movieFileId: number | null = 10894;
let queue: {
  id: number;
  title: string;
  downloadClient?: string;
  movieId?: number;
  seriesId?: number;
}[] = [];
let history: ArrHistoryRecord[] = [];
let episodes: ArrEpisode[] = [];

const profiles = [
  { id: 6, name: 'HD-1080p' },
  { id: 9, name: 'Ultra-HD' },
];

const extras = () => ({
  recycleBin: async () => recycleBin,
  removeFromQueue: async (id: number) => {
    calls.push(`remove ${id}`);
  },
  markFailed: async (id: number) => {
    calls.push(`failed ${id}`);
  },
  qualityProfiles: async () => profiles,
});

const radarr = {
  get extras() {
    return extras();
  },
  getQueue: async () => queue,
  history: async () => history,
  movieDetail: async () => ({
    id: MOVIE.arrId,
    title: 'The Driftwood',
    monitored: true,
    qualityProfileId: 6,
    hasFile: movieFileId !== null,
    movieFile:
      movieFileId === null
        ? undefined
        : {
            id: movieFileId,
            relativePath: 'The Driftwood (2026) [WEBDL-1080p].mkv',
            size: 5.1 * GB,
          },
  }),
  deleteMovieFile: async (id: number) => {
    calls.push(`delete movie file ${id}`);
  },
  setMonitored: async (id: number, monitored: boolean) => {
    calls.push(`monitored ${id} ${monitored}`);
  },
  editMovie: async (id: number, changes: { qualityProfileId?: number }) => {
    calls.push(`profile ${id} ${changes.qualityProfileId}`);
  },
  searchMovie: async (id: number) => {
    calls.push(`search ${id}`);
  },
};

const sonarr = {
  get extras() {
    return extras();
  },
  getQueue: async () => queue,
  episodes: async () => episodes,
  episodeFile: async (id: number) => ({
    id,
    relativePath: `file ${id}.mkv`,
    size: GB,
  }),
  deleteEpisodeFile: async (id: number) => {
    calls.push(`delete episode file ${id}`);
  },
  setEpisodeMonitoring: async (ids: number[], monitored: boolean) => {
    calls.push(`monitored ${ids.join(',')} ${monitored}`);
  },
  getSeriesById: async () => ({ id: SERIES.arrId, qualityProfileId: 6 }),
  editSeries: async (id: number, changes: { qualityProfileId?: number }) => {
    calls.push(`profile ${id} ${changes.qualityProfileId}`);
  },
  searchEpisodes: async (ids: number[]) => {
    calls.push(`search ${ids.join(',')}`);
  },
};

const episode = (
  id: number,
  seasonNumber: number,
  episodeNumber: number,
  episodeFileId: number,
  monitored = true
): ArrEpisode => ({
  id,
  seriesId: SERIES.arrId,
  seasonNumber,
  episodeNumber,
  hasFile: episodeFileId > 0,
  episodeFileId,
  monitored,
});

beforeEach(() => {
  calls = [];
  recycleBin = '';
  movieFileId = 10894;
  queue = [];
  history = [];
  episodes = [
    episode(1, 1, 1, 100),
    // One file holding two episodes.
    episode(2, 1, 2, 101),
    episode(3, 1, 3, 101),
    episode(4, 2, 1, 0),
    episode(5, 2, 2, 200, false),
  ];
  const settings = getSettings();
  settings.radarr = [{ id: 0, name: 'Radarr' } as unknown as RadarrSettings];
  settings.sonarr = [{ id: 0, name: 'Sonarr' } as unknown as SonarrSettings];
  mock.method(FixRadarr, 'forServer', () => radarr as unknown as FixRadarr);
  mock.method(FixSonarr, 'forServer', () => sonarr as unknown as FixSonarr);
});

afterEach(() => mock.restoreAll());

const text = (change: ProposedChange) =>
  [change.headline, ...change.details].join('\n');

describe('deleting files', () => {
  it('says plainly when a deleted file is gone for good, and only deletes the file shown', async () => {
    const change = await describeChange({
      kind: 'deleteFiles',
      title: MOVIE,
      name: 'The Driftwood',
      reason: 'It is a fake.',
    });
    assert.equal(change.headline, 'Delete the file of The Driftwood');
    assert.match(
      text(change),
      /"The Driftwood \(2026\) \[WEBDL-1080p\]\.mkv" \(5\.1 GB\)/
    );
    assert.match(
      text(change),
      /Radarr has no recycle bin, so it is gone for good/
    );
    assert.match(
      text(change),
      /still looks for the movie and will download it again/
    );
    assert.match(text(change), /Why: It is a fake\./);

    // A new file arrived since it was proposed: that one is not deleted.
    movieFileId = 10900;
    await assert.rejects(applyChange(change), ChangeError);
    assert.deepEqual(calls, []);

    movieFileId = 10894;
    assert.match(
      await applyChange(change),
      /^Deleted the file of The Driftwood\.$/
    );
    assert.deepEqual(calls, ['delete movie file 10894']);
  });

  it('names the recycle bin when there is one, and can stop the movie coming back', async () => {
    recycleBin = '/recycle';
    const change = await describeChange({
      kind: 'deleteFiles',
      title: MOVIE,
      unmonitor: true,
      reason: 'Not wanted.',
    });
    assert.match(text(change), /moves it to its recycle bin \(\/recycle\)/);
    assert.match(text(change), /Radarr stops looking for the movie/);
    await applyChange(change);
    assert.deepEqual(calls, [
      'delete movie file 10894',
      `monitored ${MOVIE.arrId} false`,
    ]);
  });

  it('deletes a season’s files once each, and leaves a file that changed since', async () => {
    const change = await describeChange({
      kind: 'deleteFiles',
      title: SERIES,
      name: 'Show',
      season: 1,
      reason: 'Wrong language.',
    });
    assert.equal(change.headline, 'Delete 2 files of Show (season 1)');
    assert.match(text(change), /Deletes 2 files, 2\.0 GB, for 3 episodes/);
    assert.deepEqual(change.params.fileIds, [100, 101]);

    // S01E01 has a new file now.
    episodes[0] = episode(1, 1, 1, 150);
    assert.match(
      await applyChange(change),
      /^Deleted 1 file \(1 had changed since and was left alone\)\.$/
    );
    assert.deepEqual(calls, ['delete episode file 101']);
  });

  it('turns down a delete with nothing to delete', async () => {
    movieFileId = null;
    await assert.rejects(
      describeChange({ kind: 'deleteFiles', title: MOVIE, reason: 'x' }),
      /has no file to delete/
    );
    await assert.rejects(
      describeChange({
        kind: 'deleteFiles',
        title: SERIES,
        season: 2,
        episodes: [1],
        reason: 'x',
      }),
      /has no files there to delete/
    );
    await assert.rejects(
      describeChange({
        kind: 'deleteFiles',
        title: SERIES,
        episodes: [1],
        reason: 'x',
      }),
      /Give the season/
    );
  });
});

describe('marking a download failed', () => {
  it('removes and blocklists what is downloading, or else the last grab', async () => {
    queue = [
      {
        id: 55,
        title: 'The.Driftwood.2026.Vandra',
        downloadClient: 'qBittorrent',
        movieId: MOVIE.arrId,
      },
      { id: 56, title: 'Another.Movie', movieId: 1 },
    ];
    const queued = await describeChange({
      kind: 'markFailed',
      title: MOVIE,
      name: 'The Driftwood',
      reason: 'A fake.',
    });
    assert.match(
      text(queued),
      /Removes "The\.Driftwood\.2026\.Vandra" from qBittorrent/
    );
    assert.deepEqual(queued.params.queueIds, [55]);

    history = [
      {
        id: 32776,
        eventType: 'grabbed',
        sourceTitle: 'The Driftwood #lynxseed',
        date: '2026-10-12T00:13:53Z',
      },
      {
        id: 32222,
        eventType: 'grabbed',
        sourceTitle: 'older',
        date: '2026-09-17T19:48:12Z',
      },
    ];
    // Gone from the queue by the time it is approved: nothing to remove.
    queue = [];
    assert.match(
      await applyChange(queued),
      /^Nothing was marked: it had already left the queue/
    );
    assert.deepEqual(calls, []);

    const grabbed = await describeChange({
      kind: 'markFailed',
      title: MOVIE,
      name: 'The Driftwood',
      reason: 'A fake.',
    });
    assert.match(text(grabbed), /Blocklists "The Driftwood #lynxseed"/);
    assert.match(text(grabbed), /The file on disk stays/);
    await applyChange(grabbed);
    assert.deepEqual(calls, ['failed 32776']);
  });

  it('turns it down for a series with nothing downloading', async () => {
    await assert.rejects(
      describeChange({
        kind: 'markFailed',
        title: SERIES,
        name: 'Show',
        reason: 'x',
      }),
      /has nothing downloading in Sonarr/
    );
  });
});

describe('changing the quality profile', () => {
  it('moves a movie to a profile named in any case, and searches if asked', async () => {
    const change = await describeChange({
      kind: 'changeProfile',
      title: MOVIE,
      name: 'The Driftwood',
      profile: 'ultra-hd',
      search: true,
      reason: 'They want 4K.',
    });
    assert.equal(change.headline, 'Move The Driftwood to the Ultra-HD profile');
    assert.match(text(change), /from HD-1080p to Ultra-HD/);
    assert.match(
      await applyChange(change),
      /Moved it to Ultra-HD and started a search/
    );
    assert.deepEqual(calls, [
      `profile ${MOVIE.arrId} 9`,
      `search ${MOVIE.arrId}`,
    ]);
  });

  it('searches every monitored episode of a series, not just missing ones', async () => {
    const change = await describeChange({
      kind: 'changeProfile',
      title: SERIES,
      name: 'Show',
      profile: 'Ultra-HD',
      search: true,
      reason: 'x',
    });
    await applyChange(change);
    assert.deepEqual(calls, [`profile ${SERIES.arrId} 9`, 'search 1,2,3,4']);
  });

  it('names the profiles there are when one is not found, and refuses the one it has', async () => {
    await assert.rejects(
      describeChange({
        kind: 'changeProfile',
        title: MOVIE,
        profile: '4K',
        reason: 'x',
      }),
      /There is no quality profile called "4K"\. There are: HD-1080p, Ultra-HD\./
    );
    await assert.rejects(
      describeChange({
        kind: 'changeProfile',
        title: MOVIE,
        name: 'The Driftwood',
        profile: 'HD-1080p',
        reason: 'x',
      }),
      /The Driftwood already uses HD-1080p/
    );
  });
});

describe('release groups', () => {
  it('turns down blocking a group twice, or unblocking one that is not', async () => {
    getSettings().backfill = {
      ...getSettings().backfill,
      blockedGroups: ['quillowsap'],
    };
    await assert.rejects(
      describeChange({ kind: 'blockGroup', group: 'QUILLOWSAP', reason: 'x' }),
      /already blocked/
    );
    await assert.rejects(
      describeChange({ kind: 'unblockGroup', group: 'FLUX', reason: 'x' }),
      /FLUX is not blocked/
    );
    await assert.rejects(
      describeChange({ kind: 'blockGroup', group: '(.*)', reason: 'x' }),
      /Give the release group/
    );
    const change = await describeChange({
      kind: 'blockGroup',
      group: 'lynxseed',
      reason: 'Fakes.',
    });
    assert.match(text(change), /Radarr and Sonarr reject them too/);
    assert.match(
      text(change),
      /replaces the file only once that one has imported/
    );
  });
});
