import type { MigrationInterface, QueryRunner } from 'typeorm';

const COLUMNS = [
  ['media_list', 'createdAt'],
  ['media_list', 'updatedAt'],
  ['media_list_item', 'createdAt'],
  ['media_list_watch_suggestion', 'createdAt'],
  ['notification_delivery', 'sentAt'],
  ['media_request_watcher', 'createdAt'],
] as const;

/*
 * When a list, a title on a list, a watch suggestion, a sent notification
 * or a request watcher was made was stored without a time zone, written
 * by Postgres in its own zone and read by Seerr as if in Seerr's, which
 * put them hours out. They are read in Postgres's zone, which wrote them,
 * and kept with the zone from now on. SQLite keeps these in UTC already.
 */
export class TimestampsWithZone1794900000000 implements MigrationInterface {
  name = 'TimestampsWithZone1794900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [table, column] of COLUMNS) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE TIMESTAMP WITH TIME ZONE USING "${column}" AT TIME ZONE current_setting('TimeZone')`
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [table, column] of COLUMNS) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE TIMESTAMP USING "${column}" AT TIME ZONE current_setting('TimeZone')`
      );
    }
  }
}
