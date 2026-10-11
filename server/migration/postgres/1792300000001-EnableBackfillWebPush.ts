import type { MigrationInterface, QueryRunner } from 'typeorm';

const BACKFILL = 32768;

export class EnableBackfillWebPush1792300000001 implements MigrationInterface {
  name = 'EnableBackfillWebPush1792300000001';

  /**
   * Backfill's notification is new, so the bit is absent from every stored
   * web push mask, which would read as "turned off". Writing it in makes it
   * on for everyone who already has a mask; only admins are ever sent it,
   * and anyone can untick it later.
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows: { id: number; notificationTypes: string | null }[] =
      await queryRunner.query(
        `SELECT "id", "notificationTypes" FROM "user_settings"`
      );

    for (const row of rows) {
      if (!row.notificationTypes) {
        continue;
      }

      let parsed: Record<string, number>;

      try {
        parsed = JSON.parse(row.notificationTypes);
      } catch {
        continue;
      }

      if (!parsed || typeof parsed !== 'object') {
        continue;
      }

      // A user with no webpush entry is already covered by the "never
      // configured" default, so only existing masks need the bit.
      if (typeof parsed.webpush !== 'number') {
        continue;
      }

      if (parsed.webpush & BACKFILL) {
        continue;
      }

      parsed.webpush |= BACKFILL;

      await queryRunner.query(
        `UPDATE "user_settings" SET "notificationTypes" = $1 WHERE "id" = $2`,
        [JSON.stringify(parsed), row.id]
      );
    }
  }

  public async down(): Promise<void> {
    // Removing the bit would silently disable a setting the user may have
    // deliberately enabled, so this is intentionally not reversed.
  }
}
