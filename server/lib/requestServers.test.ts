import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MediaType } from '@server/constants/media';
import {
  chosenServerFor,
  chosenServerProblem,
  requestServerIssue,
} from '@server/lib/requestServers';
import type {
  LidarrSettings,
  RadarrSettings,
  SonarrSettings,
} from '@server/lib/settings';

const radarr = (id: number, is4k: boolean, isDefault = true) =>
  ({ id, is4k, isDefault, name: `Radarr ${id}` }) as RadarrSettings;

const settings = {
  radarr: [radarr(1, false), radarr(2, true)],
  sonarr: [] as SonarrSettings[],
  lidarr: [{ id: 5, isDefault: true } as LidarrSettings],
};

describe('chosenServerProblem', () => {
  it('takes a server of the request’s kind, 4K or not', () => {
    for (const [serverId, is4k] of [
      [1, false],
      [2, true],
    ] as const) {
      assert.equal(
        chosenServerProblem(
          { type: MediaType.MOVIE, serverId, is4k },
          settings
        ),
        undefined
      );
    }
  });

  it('refuses a 4K server for a request that is not 4K, and the reverse', () => {
    assert.equal(
      chosenServerProblem(
        { type: MediaType.MOVIE, serverId: 2, is4k: false },
        settings
      ),
      'only4k'
    );
    assert.equal(
      chosenServerProblem(
        { type: MediaType.MOVIE, serverId: 1, is4k: true },
        settings
      ),
      'not4k'
    );
  });

  it('refuses a server that is not there', () => {
    assert.equal(
      chosenServerProblem({ type: MediaType.MOVIE, serverId: 9 }, settings),
      'unknown'
    );
  });

  it('takes any id when no server of the kind is set up, or none chosen', () => {
    assert.equal(
      chosenServerProblem({ type: MediaType.TV, serverId: 9 }, settings),
      undefined
    );
    assert.equal(
      chosenServerProblem({ type: MediaType.MOVIE, serverId: null }, settings),
      undefined
    );
  });

  it('has no 4K for Lidarr', () => {
    assert.equal(
      chosenServerProblem(
        { type: MediaType.MUSIC, serverId: 5, is4k: true },
        settings
      ),
      undefined
    );
  });
});

describe('a request whose chosen server is of the other kind', () => {
  const request = { type: MediaType.MOVIE, serverId: 2, is4k: false };

  it('is not sent there', () => {
    assert.equal(chosenServerFor(request, settings), undefined);
    assert.equal(chosenServerFor({ ...request, is4k: true }, settings)?.id, 2);
  });

  it('is held as having lost its server, for Retry to send to the default', () => {
    assert.deepEqual(requestServerIssue(request, settings), {
      reason: 'removed',
      service: 'radarr',
      usesDefault: true,
    });
  });
});
