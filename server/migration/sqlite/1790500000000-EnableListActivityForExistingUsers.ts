import type { MigrationInterface, QueryRunner } from 'typeorm';

const LIST_ACTIVITY = 8192;

export class EnableListActivityForExistingUsers1790500000000 implements MigrationInterface {
  name = 'EnableListActivityForExistingUsers1790500000000';

  /**
   * List Activity did not exist when these preferences were saved, so the bit
   * is absent from every stored web push mask. Left alone that reads as "the
   * user turned it off" and there is no way to tell the two apart — so the
   * setting could never be switched off again.
   *
   * Writing the bit in now makes the stored value mean what it says: on for
   * everyone today, and genuinely off for anyone who unticks it later.
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

      if (parsed.webpush & LIST_ACTIVITY) {
        continue;
      }

      parsed.webpush |= LIST_ACTIVITY;

      await queryRunner.query(
        `UPDATE "user_settings" SET "notificationTypes" = ? WHERE "id" = ?`,
        [JSON.stringify(parsed), row.id]
      );
    }
  }

  public async down(): Promise<void> {
    // Removing the bit would silently disable a setting the user may have
    // deliberately enabled, so this is intentionally not reversed.
  }
}
