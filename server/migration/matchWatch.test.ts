import dataSource, { getRepository } from '@server/datasource';
import { MatchProblem, MatchWatch } from '@server/entity/MatchWatch';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import migrateWrongMatchNotifications from '@server/lib/settings/migrations/0014_wrong_match_notifications';
import { AddMatchWatch1795800000000 as PostgresMigration } from '@server/migration/postgres/1795800000000-AddMatchWatch';
import { AddMatchWatch1795800000000 as SqliteMigration } from '@server/migration/sqlite/1795800000000-AddMatchWatch';
import { setupTestDb } from '@server/test/db';
import { isPgsql } from '@server/utils/dbType';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * The tables the check of new requests keeps its work in, made by the
 * migration for whichever database the tests run on (DB_TYPE=postgres for
 * Postgres); and the new Wrong Match notification turned on wherever
 * Health was, for each person and each channel.
 */

setupTestDb();

const HEALTH = 65536;
const WRONG_MATCH = 131072;

describe('the wrong match migration', () => {
  it('makes the tables the entities expect, and gives Wrong Match to whoever has Health', async () => {
    const migration = isPgsql ? new PostgresMigration() : new SqliteMigration();
    const admin = await getRepository(User).findOneOrFail({
      where: { id: 1 },
      relations: { settings: true },
    });
    const friend = await getRepository(User).findOneOrFail({
      where: { id: 2 },
      relations: { settings: true },
    });
    const runner = dataSource.createQueryRunner();
    try {
      await migration.down(runner);
      assert.equal(await runner.hasTable('match_watch'), false);
      assert.equal(await runner.hasTable('match_problem'), false);

      // Saved before the notification existed.
      const masks = async (userId: number, types: Record<string, number>) => {
        const settings = await getRepository(UserSettings).findOne({
          where: { user: { id: userId } },
        });
        await runner.query(
          `UPDATE "user_settings" SET "notificationTypes" = ${isPgsql ? '$1' : '?'} WHERE "id" = ${isPgsql ? '$2' : '?'}`,
          [JSON.stringify(types), settings?.id]
        );
      };
      if (!admin.settings) {
        await getRepository(UserSettings).save(
          new UserSettings({ user: admin })
        );
      }
      if (!friend.settings) {
        await getRepository(UserSettings).save(
          new UserSettings({ user: friend })
        );
      }
      await masks(1, { email: HEALTH | 8, webpush: 8, discord: HEALTH });
      await masks(2, { email: 8 });

      await migration.up(runner);
    } finally {
      await runner.release();
    }

    const types = async (userId: number) =>
      (
        await getRepository(UserSettings).findOneOrFail({
          where: { user: { id: userId } },
        })
      ).notificationTypes;
    assert.deepEqual(await types(1), {
      email: HEALTH | 8 | WRONG_MATCH,
      webpush: 8,
      discord: HEALTH | WRONG_MATCH,
    });
    assert.equal((await types(2)).email, 8, 'no Health, so no Wrong Match');

    // The tables work, and nothing about them is left for the schema to
    // change: the migration and the entities agree.
    await getRepository(MatchWatch).insert({
      mediaId: 1,
      kind: 'movie',
      mediaServer: 'Plex',
      arrServerId: 0,
      arrItemId: 10,
      importedAt: new Date(),
      nextCheckAt: new Date(),
    });
    await getRepository(MatchProblem).insert({
      key: 'Plex|movie|tmdb:1|tmdb:2',
      mediaServer: 'Plex',
      kind: 'movie',
      problem: '{}',
      foundAt: new Date(),
    });
    assert.equal(
      (await getRepository(MatchProblem).findOneOrFail({ where: {} })).notice,
      'waiting'
    );
    const pending = await dataSource.driver.createSchemaBuilder().log();
    assert.deepEqual(
      pending.upQueries
        .map((query) => query.query)
        .filter((query) => /match_(watch|problem)/.test(query)),
      []
    );
  });
});

describe('settings migration 0014', () => {
  it('gives Wrong Match to each channel that sends Health, once', () => {
    const before = {
      notifications: {
        agents: {
          discord: { types: HEALTH | 8 },
          slack: { types: 8 },
          email: { types: 0 },
          webpush: {},
        },
      },
      migrations: ['0012_trim_music_search'],
    };
    const after = migrateWrongMatchNotifications(
      structuredClone(before)
    ) as any;
    assert.equal(
      after.notifications.agents.discord.types,
      HEALTH | 8 | WRONG_MATCH
    );
    assert.equal(after.notifications.agents.slack.types, 8);
    assert.equal(
      after.notifications.agents.email.types,
      0,
      'everything already'
    );
    assert.ok(after.migrations.includes('0014_wrong_match_notifications'));

    // Turned off afterwards, it stays off.
    after.notifications.agents.discord.types = HEALTH | 8;
    const again = migrateWrongMatchNotifications(structuredClone(after)) as any;
    assert.equal(again.notifications.agents.discord.types, HEALTH | 8);
  });
});
