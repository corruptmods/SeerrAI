import dataSource, { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { AddPersonalNotificationTypes1797700000000 as PostgresMigration } from '@server/migration/postgres/1797700000000-AddPersonalNotificationTypes';
import { AddPersonalNotificationTypes1797700000000 as SqliteMigration } from '@server/migration/sqlite/1797700000000-AddPersonalNotificationTypes';
import { setupTestDb } from '@server/test/db';
import { isPgsql } from '@server/utils/dbType';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * Request Failed, Playlist Updates and Leaving Soon given to whoever had
 * the notifications they come from, and web push kept to what it sent
 * before every type could be chosen there.
 */

setupTestDb();

const MEDIA_APPROVED = 4;
const MEDIA_AVAILABLE = 8;
const MEDIA_FAILED = 16;
const ISSUE_CREATED = 256;
const PLAYLIST_UPDATE = 262144;
const REQUEST_FAILED = 524288;
const LEAVING_SOON = 1048576;

describe('the personal notification types migration', () => {
  it('follows what each person had, service by service', async () => {
    const migration = isPgsql ? new PostgresMigration() : new SqliteMigration();
    const user = await getRepository(User).findOneOrFail({
      where: { id: 2 },
      relations: { settings: true },
    });
    const settings =
      user.settings ??
      (await getRepository(UserSettings).save(new UserSettings({ user })));
    const runner = dataSource.createQueryRunner();
    try {
      await runner.query(
        `UPDATE "user_settings" SET "notificationTypes" = ${isPgsql ? '$1' : '?'} WHERE "id" = ${isPgsql ? '$2' : '?'}`,
        [
          JSON.stringify({
            email: MEDIA_FAILED | MEDIA_APPROVED,
            webpush: MEDIA_AVAILABLE | MEDIA_APPROVED | ISSUE_CREATED,
            telegram: MEDIA_APPROVED,
            discord: MEDIA_FAILED | MEDIA_AVAILABLE,
          }),
          settings.id,
        ]
      );
      await migration.up(runner);
    } finally {
      await runner.release();
    }
    const after = await getRepository(UserSettings).findOneOrFail({
      where: { id: settings.id },
    });
    assert.deepEqual(after.notificationTypes, {
      email: MEDIA_FAILED | MEDIA_APPROVED | REQUEST_FAILED | PLAYLIST_UPDATE,
      // What web push never sent stays off until chosen.
      webpush: MEDIA_AVAILABLE | LEAVING_SOON,
      telegram: MEDIA_APPROVED,
      // Discord only mentions people in its channel, which these never reach.
      discord: MEDIA_FAILED | MEDIA_AVAILABLE,
    });
  });
});
