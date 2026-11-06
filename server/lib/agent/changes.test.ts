import type { ProposedChange } from '@server/lib/agent/changes';
import {
  ChangeError,
  applyChange,
  applySeasonChange,
  describeChange,
  describeSeasonReplace,
} from '@server/lib/agent/changes';
import type {
  ArrEpisode,
  ArrHistoryRecord,
  ArrRelease,
} from '@server/lib/autofix/arr';
import { FixRadarr, FixSonarr } from '@server/lib/autofix/arr';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

/*
 * Admin-agent proposals: what an admin is shown, and what runs on approval,
 * rechecked against Radarr and Sonarr as they are by then. Both are stubs
 * that record what was asked of them.
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
/** Sonarr's season search, and each episode's own search. */
let seasonReleases: ArrRelease[] = [];
let episodeReleases: Record<number, ArrRelease[]> = {};

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
  seriesFacts: async () => ({
    title: 'Static Garden',
    originalLanguage: 'English',
  }),
  seasonHistory: async () => [],
  seasonReleases: async () => seasonReleases,
  releases: async (episodeId: number) => episodeReleases[episodeId] ?? [],
  grab: async (release: ArrRelease) => {
    calls.push(`grab ${release.guid} ${release.indexerId}`);
  },
  monitorEpisodes: async () => undefined,
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
  seasonReleases = [];
  episodeReleases = {};
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

    // A file that arrived after the proposal is not deleted.
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

  it('removes only the title’s own downloads, whatever the queue holds by then', async () => {
    queue = [{ id: 61, title: 'Static.Garden.S01E01', seriesId: SERIES.arrId }];
    const proposed = await describeChange({
      kind: 'markFailed',
      title: SERIES,
      name: 'Static Garden',
      reason: 'A fake.',
    });
    assert.deepEqual(proposed.params.queueIds, [61]);
    // By approval, the same queue id belongs to another series.
    queue = [{ id: 61, title: 'Harbour.Lights.S02E04', seriesId: 78 }];
    assert.match(
      await applyChange(proposed),
      /^Nothing was marked: it had already left the queue/
    );
    assert.deepEqual(calls, []);
    queue = [{ id: 61, title: 'Static.Garden.S01E01', seriesId: SERIES.arrId }];
    await applyChange(proposed);
    assert.deepEqual(calls, ['remove 61']);
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

describe('replacing a whole season', () => {
  const offered = (
    guid: string,
    indexerId: number,
    title: string,
    over: Partial<ArrRelease> = {}
  ): ArrRelease => ({
    guid,
    indexerId,
    indexer: `Indexer ${indexerId}`,
    title,
    downloadAllowed: true,
    rejected: false,
    ...over,
  });
  const PACK = 'Static.Garden.S01.1080p-NEWGRP';
  const pack = (guid: string, indexerId: number, title = PACK) =>
    offered(guid, indexerId, title, { fullSeason: true, seasonNumber: 1 });
  const single = (guid: string, episodeId: number, n: number) =>
    offered(guid, 1, `Static.Garden.S01E0${n}.1080p-EPGRP`, {
      mappedEpisodeInfo: [{ id: episodeId }],
    });
  /** The change as stored with the run and read back. */
  const stored = (change: ProposedChange): ProposedChange =>
    JSON.parse(JSON.stringify(change));

  it('takes only the season pack shown, never one of the same name from another indexer', async () => {
    seasonReleases = [pack('g-harbour', 1)];
    const change = stored(
      await describeSeasonReplace(SERIES, 1, 'The season is bad.')
    );
    assert.match(text(change), new RegExp(`"${PACK}" from Indexer 1`));
    assert.deepEqual(calls, []);

    seasonReleases = [
      pack('g-lantern', 2, 'Static Garden S01 1080p NEWGRP'),
      pack('g-harbour', 1),
    ];
    const outcome = await applySeasonChange(change);
    assert.equal(outcome.ok, true, outcome.message);
    assert.deepEqual(calls, [
      'grab g-harbour 1',
      'delete episode file 100',
      'delete episode file 101',
    ]);
  });

  it('grabs and removes nothing when the season pack shown is no longer offered', async () => {
    seasonReleases = [pack('g-harbour', 1)];
    const change = stored(await describeSeasonReplace(SERIES, 1, 'Bad.'));

    for (const now of [
      [pack('g-lantern', 2, 'Static Garden S01 1080p NEWGRP')],
      [pack('g-other', 3, 'Static.Garden.S01.2160p-OTHERGRP')],
      [pack('g-harbour', 4)],
      [],
    ]) {
      seasonReleases = now;
      const outcome = await applySeasonChange(change);
      assert.equal(outcome.ok, false);
      assert.match(outcome.message, /approved release is no longer offered/);
    }
    assert.deepEqual(calls, []);
  });

  it('takes only the per-episode releases shown, even when a season pack turns up', async () => {
    seasonReleases = [single('g-e1', 1, 1), single('g-e2', 2, 2)];
    episodeReleases = { 3: [single('g-e3', 3, 3)] };
    const change = stored(await describeSeasonReplace(SERIES, 1, 'Bad.'));
    assert.match(text(change), /S01E03: downloads/);

    // A pack now leads the listing, and episode 3 is only found by its own
    // search.
    seasonReleases = [
      pack('g-other', 3, 'Static.Garden.S01.2160p-OTHERGRP'),
      single('g-e1', 1, 1),
      single('g-e2', 2, 2),
    ];
    const outcome = await applySeasonChange(change);
    assert.equal(outcome.ok, true, outcome.message);
    assert.deepEqual(calls, [
      'grab g-e1 1',
      'grab g-e2 1',
      'grab g-e3 1',
      'delete episode file 100',
      'delete episode file 101',
    ]);
  });

  it('grabs and removes nothing when one of the per-episode releases shown is gone', async () => {
    seasonReleases = [single('g-e1', 1, 1), single('g-e2', 2, 2)];
    episodeReleases = { 3: [single('g-e3', 3, 3)] };
    const change = stored(await describeSeasonReplace(SERIES, 1, 'Bad.'));

    seasonReleases = [
      pack('g-other', 3, 'Static.Garden.S01.2160p-OTHERGRP'),
      single('g-e1', 1, 1),
      single('g-e2', 2, 2),
    ];
    episodeReleases = { 3: [single('g-e3-new', 3, 3)] };
    const outcome = await applySeasonChange(change);
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /approved release is no longer offered/);
    assert.deepEqual(calls, []);
  });

  it('grabs and removes nothing for an approval that does not name its releases', async () => {
    seasonReleases = [pack('g-harbour', 1)];
    const outcome = await applySeasonChange({
      kind: 'replaceSeason',
      headline: 'Replace season 1 of Static Garden',
      details: [],
      title: SERIES,
      params: { season: 1, prefer: PACK },
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /does not name the releases to take/);
    assert.deepEqual(calls, []);
  });
});
