import dataSource from '@server/datasource';
import { AddOverrideRuleCountry1797900000000 as PostgresCountry } from '@server/migration/postgres/1797900000000-AddOverrideRuleCountry';
import { AddRequestOverQuota1797900000001 as PostgresOverQuota } from '@server/migration/postgres/1797900000001-AddRequestOverQuota';
import { AddUserDefaultProfiles1797900000002 as PostgresDefaults } from '@server/migration/postgres/1797900000002-AddUserDefaultProfiles';
import { AddOverrideRuleCountry1797900000000 as SqliteCountry } from '@server/migration/sqlite/1797900000000-AddOverrideRuleCountry';
import { AddRequestOverQuota1797900000001 as SqliteOverQuota } from '@server/migration/sqlite/1797900000001-AddRequestOverQuota';
import { AddUserDefaultProfiles1797900000002 as SqliteDefaults } from '@server/migration/sqlite/1797900000002-AddUserDefaultProfiles';
import { setupTestDb } from '@server/test/db';
import { isPgsql } from '@server/utils/dbType';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MigrationInterface } from 'typeorm';

/*
 * The columns for an override rule's countries, requests made over quota and
 * people's default quality profiles, added by the migrations for whichever
 * database the tests run on (DB_TYPE=postgres for Postgres).
 */

setupTestDb();

const columnsOf = async (table: string) => {
  const runner = dataSource.createQueryRunner();
  try {
    return new Map(
      (await runner.getTable(table))?.columns.map((column) => [
        column.name,
        column,
      ])
    );
  } finally {
    await runner.release();
  }
};

const cases: {
  table: string;
  column: string;
  migration: MigrationInterface;
  nullable: boolean;
}[] = [
  {
    table: 'override_rule',
    column: 'country',
    migration: isPgsql ? new PostgresCountry() : new SqliteCountry(),
    nullable: true,
  },
  {
    table: 'media_request',
    column: 'overQuota',
    migration: isPgsql ? new PostgresOverQuota() : new SqliteOverQuota(),
    nullable: false,
  },
  {
    table: 'user_settings',
    column: 'defaultProfiles',
    migration: isPgsql ? new PostgresDefaults() : new SqliteDefaults(),
    nullable: true,
  },
];

describe('the request choices migrations', () => {
  for (const { table, column, migration, nullable } of cases) {
    it(`add ${table}.${column} as the entity has it, and take it away again`, async () => {
      const runner = dataSource.createQueryRunner();
      try {
        await migration.down(runner);
        assert.equal((await columnsOf(table)).has(column), false);

        await migration.up(runner);
        assert.equal(
          (await columnsOf(table)).get(column)?.isNullable,
          nullable
        );
      } finally {
        await runner.release();
      }

      const pending = await dataSource.driver.createSchemaBuilder().log();
      assert.deepEqual(
        pending.upQueries
          .map((query) => query.query)
          .filter((query) => query.includes(`"${column}"`)),
        []
      );
    });
  }
});
