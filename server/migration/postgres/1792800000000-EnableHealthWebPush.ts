import type { MigrationInterface, QueryRunner } from 'typeorm';

const HEALTH = 65536;

export class EnableHealthWebPush1792800000000 implements MigrationInterface {
  name = 'EnableHealthWebPush1792800000000';

  /**
   * The Health notification is new, so the bit is absent from every stored
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

      if (parsed.webpush & HEALTH) {
        continue;
      }

      parsed.webpush |= HEALTH;

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
