import type { MigrationInterface, QueryRunner } from 'typeorm';

const COLUMNS = [
  ['backfill_series', 'createdAt'],
  ['backfill_series', 'updatedAt'],
  ['backfill_candidate', 'createdAt'],
  ['backfill_candidate', 'updatedAt'],
  ['backfill_job', 'createdAt'],
  ['backfill_job', 'updatedAt'],
] as const;

/*
 * Backfill's created and updated times were stored without a time zone,
 * written by Postgres in its own zone and read by Seerr as if in Seerr's,
 * which put them hours out. They are read in Postgres's zone, which wrote
 * them, and kept with the zone from now on.
 */
export class BackfillTimestampsWithZone1792400000000 implements MigrationInterface {
  name = 'BackfillTimestampsWithZone1792400000000';

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
