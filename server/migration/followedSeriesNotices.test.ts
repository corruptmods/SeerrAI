import dataSource, { getRepository } from '@server/datasource';
import FutureSeasonSubscription from '@server/entity/FutureSeasonSubscription';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { AddFollowedSeriesNotices1797940000000 as PostgresMigration } from '@server/migration/postgres/1797940000000-AddFollowedSeriesNotices';
import { AddFollowedSeriesNotices1797940000000 as SqliteMigration } from '@server/migration/sqlite/1797940000000-AddFollowedSeriesNotices';
import { setupTestDb } from '@server/test/db';
import { isPgsql } from '@server/utils/dbType';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * The latest season each follower was told premiered, and Followed Series
 * given to whoever is told what's ready, for whichever database the tests run
 * on (DB_TYPE=postgres for Postgres).
 */

setupTestDb();

const MEDIA_APPROVED = 4;
const MEDIA_AVAILABLE = 8;
const FOLLOWED_SERIES = 2097152;

describe('the followed series notices migration', () => {
  it('starts existing follows at the season before the next they wait for', async () => {
    const user = await getRepository(User).findOneOrFail({ where: { id: 2 } });
    await getRepository(FutureSeasonSubscription).save(
      new FutureSeasonSubscription({ user, tmdbId: 300, fromSeason: 4 })
    );
    const migration = isPgsql ? new PostgresMigration() : new SqliteMigration();
    const runner = dataSource.createQueryRunner();
    try {
      await migration.down(runner);
      const before = await runner.getTable('future_season_subscription');
      assert.equal(before?.findColumnByName('premieredSeason'), undefined);
      await migration.up(runner);
    } finally {
      await runner.release();
    }

    const [subscription] = await getRepository(FutureSeasonSubscription).find();
    assert.equal(subscription.fromSeason, 4);
    assert.equal(subscription.premieredSeason, 3);

    const pending = await dataSource.driver.createSchemaBuilder().log();
    assert.deepEqual(
      pending.upQueries
        .map((query) => query.query)
        .filter((query) => /future_season_subscription/.test(query)),
      [],
      'the column agrees with the entity'
    );
  });

  it('gives Followed Series to whoever is told what is ready', async () => {
    const user = await getRepository(User).findOneOrFail({
      where: { id: 2 },
      relations: { settings: true },
    });
    const settings =
      user.settings ??
      (await getRepository(UserSettings).save(new UserSettings({ user })));
    const migration = isPgsql ? new PostgresMigration() : new SqliteMigration();
    const runner = dataSource.createQueryRunner();
    try {
      await runner.query(
        `UPDATE "user_settings" SET "notificationTypes" = ${isPgsql ? '$1' : '?'} WHERE "id" = ${isPgsql ? '$2' : '?'}`,
        [
          JSON.stringify({
            email: MEDIA_AVAILABLE | MEDIA_APPROVED,
            webpush: MEDIA_APPROVED,
            telegram: MEDIA_AVAILABLE,
            discord: MEDIA_AVAILABLE,
          }),
          settings.id,
        ]
      );
      await migration.down(runner);
      await migration.up(runner);
    } finally {
      await runner.release();
    }
    const after = await getRepository(UserSettings).findOneOrFail({
      where: { id: settings.id },
    });
    assert.deepEqual(after.notificationTypes, {
      email: MEDIA_AVAILABLE | MEDIA_APPROVED | FOLLOWED_SERIES,
      webpush: MEDIA_APPROVED,
      telegram: MEDIA_AVAILABLE | FOLLOWED_SERIES,
      // Discord only mentions people in its channel, which this never reaches.
      discord: MEDIA_AVAILABLE,
    });
  });
});
