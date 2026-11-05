import TautulliAPI from '@server/api/tautulli';
import type { User } from '@server/entity/User';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('plays from Tautulli since a time', () => {
  it('asks from the day before, so a different time zone loses no plays', async () => {
    const api = new TautulliAPI({
      hostname: 'tautulli.invalid',
      port: 8181,
      apiKey: 'x',
    });
    const asked: Record<string, unknown>[] = [];
    // 00:30 on 10 May, Seerr's time.
    const added = new Date(2026, 4, 10, 0, 30);
    const seconds = Math.floor(added.getTime() / 1000);

    (api as unknown as { axios: { get: unknown } }).axios.get = async (
      _url: string,
      { params }: { params: Record<string, unknown> }
    ) => {
      asked.push(params);
      return {
        data: {
          response: {
            data: {
              data: [
                { date: seconds + 60, rating_key: 1 },
                { date: seconds - 60, rating_key: 1 },
              ],
            },
          },
        },
      };
    };

    const plays = await api.getUserPlaysSince({ id: 1, plexId: 7 } as User, {
      ratingKey: '1',
      after: added,
    });

    // Tautulli reads the date as its local midnight. A Tautulli a few hours
    // behind is still on 9 May, so asking from the 10th would miss plays.
    assert.equal(asked[0].after, '2026-05-09');
    // The exact time is still the cutoff.
    assert.deepEqual(
      plays.map((play) => play.date),
      [seconds + 60]
    );
  });
});
