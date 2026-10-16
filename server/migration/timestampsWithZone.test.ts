import { MediaRequestStatus, MediaType } from '@server/constants/media';
import dataSource from '@server/datasource';
import Media from '@server/entity/Media';
import {
  MediaList,
  MediaListItem,
  MediaListWatchSuggestion,
} from '@server/entity/MediaList';
import { MediaRequest } from '@server/entity/MediaRequest';
import MediaRequestWatcher from '@server/entity/MediaRequestWatcher';
import NotificationDelivery from '@server/entity/NotificationDelivery';
import { User } from '@server/entity/User';
import { TimestampsWithZone1794900000000 } from '@server/migration/postgres/1794900000000-TimestampsWithZone';
import { setupTestDb } from '@server/test/db';
import { isPgsql } from '@server/utils/dbType';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * Times the database fills in itself (when a list, a list title, a watch
 * suggestion, a sent notification or a request watcher was made) read back
 * as the moment they were made, whatever time zone Postgres runs in.
 */

setupTestDb();

/** A time zone hours away from the one Node runs in. */
const farZone = () =>
  new Date().getTimezoneOffset() === -14 * 60
    ? 'Pacific/Pago_Pago'
    : 'Pacific/Kiritimati';

const assertNow = (label: string, value: Date) => {
  const off = Math.abs(new Date(value).getTime() - Date.now());
  assert.ok(off < 5 * 60 * 1000, `${label} is ${off / 3600000} hours out`);
};

describe('times the database fills in', () => {
  it('read back as the moment they were made, whatever the database’s time zone', async () => {
    await dataSource.transaction(async (manager) => {
      if (isPgsql) {
        // As when Postgres runs in another zone than Seerr: this
        // transaction's now() is in that zone.
        await manager.query(`SET LOCAL TIME ZONE '${farZone()}'`);
      }
      const owner = await manager.findOneOrFail(User, {
        where: { id: 1 },
      });

      const list = await manager.save(
        new MediaList({ name: 'Weekend', owner, ownerId: owner.id })
      );
      const item = await manager.save(
        new MediaListItem({
          list,
          listId: list.id,
          tmdbId: 550,
          mediaType: 'movie',
        })
      );
      const suggestion = await manager.save(
        new MediaListWatchSuggestion({
          list,
          listId: list.id,
          item,
          itemId: item.id,
        })
      );
      await manager.update(MediaList, list.id, { name: 'Weekend films' });

      const media = await manager.save(
        new Media({ mediaType: MediaType.MOVIE, tmdbId: 550 }),
        { listeners: false }
      );
      const request = await manager.save(
        new MediaRequest({
          type: MediaType.MOVIE,
          status: MediaRequestStatus.PENDING,
          media,
          requestedBy: owner,
          is4k: false,
        }),
        { listeners: false }
      );
      const watcher = await manager.save(
        new MediaRequestWatcher({
          request,
          requestId: request.id,
          user: owner,
          userId: owner.id,
        })
      );
      const delivery = await manager.save(
        new NotificationDelivery({ requestId: request.id, type: 1 })
      );

      const savedList = await manager.findOneByOrFail(MediaList, {
        id: list.id,
      });
      assertNow('A list’s creation', savedList.createdAt);
      assertNow('A list’s last change', savedList.updatedAt);
      assertNow(
        'A list title’s addition',
        (await manager.findOneByOrFail(MediaListItem, { id: item.id }))
          .createdAt
      );
      assertNow(
        'A watch suggestion',
        (
          await manager.findOneByOrFail(MediaListWatchSuggestion, {
            id: suggestion.id,
          })
        ).createdAt
      );
      assertNow(
        'A request watcher',
        (await manager.findOneByOrFail(MediaRequestWatcher, { id: watcher.id }))
          .createdAt
      );
      assertNow(
        'A sent notification',
        (
          await manager.findOneByOrFail(NotificationDelivery, {
            id: delivery.id,
          })
        ).sentAt
      );
    });
  });

  it(
    'are kept with their zone by the Postgres migration, and keep their moment',
    { skip: !isPgsql },
    async () => {
      const migration = new TimestampsWithZone1794900000000();
      const runner = dataSource.createQueryRunner();
      const zoneOf = async (table: string, column: string) =>
        (
          await runner.query(
            `SELECT data_type FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
            [table, column]
          )
        )[0].data_type;
      try {
        // Postgres in another zone than Seerr, writing a list before the
        // migration.
        await runner.query(`SET TIME ZONE '${farZone()}'`);
        await migration.down(runner);
        assert.equal(
          await zoneOf('media_list', 'createdAt'),
          'timestamp without time zone'
        );
        await runner.query(
          `INSERT INTO "media_list" ("name", "ownerId") VALUES ('Before', 1)`
        );

        await migration.up(runner);

        for (const [table, column] of [
          ['media_list', 'createdAt'],
          ['media_list', 'updatedAt'],
          ['media_list_item', 'createdAt'],
          ['media_list_watch_suggestion', 'createdAt'],
          ['notification_delivery', 'sentAt'],
          ['media_request_watcher', 'createdAt'],
        ]) {
          assert.equal(
            await zoneOf(table, column),
            'timestamp with time zone',
            `${table}.${column}`
          );
        }
      } finally {
        await runner.query('RESET TIME ZONE');
        await runner.release();
      }

      const list = await dataSource
        .getRepository(MediaList)
        .findOneByOrFail({ name: 'Before' });
      assertNow('A list made before the migration', list.createdAt);

      // Nothing about these left for the schema to change: the migration and
      // the entities agree.
      const pending = await dataSource.driver.createSchemaBuilder().log();
      assert.deepEqual(
        pending.upQueries
          .map((query) => query.query)
          .filter((query) =>
            /media_list|notification_delivery|media_request_watcher/.test(query)
          ),
        []
      );
    }
  );
});
