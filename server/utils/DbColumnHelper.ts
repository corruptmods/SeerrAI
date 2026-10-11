import { isPgsql } from '@server/utils/dbType';
import type { ColumnOptions, ColumnType } from 'typeorm';
import { Column } from 'typeorm';
const pgTypeMapping: { [key: string]: ColumnType } = {
  datetime: 'timestamp with time zone',
};

export function resolveDbType(pgType: ColumnType): ColumnType {
  if (isPgsql && pgType.toString() in pgTypeMapping) {
    return pgTypeMapping[pgType.toString()];
  }
  return pgType;
}

export function DbAwareColumn(columnOptions: ColumnOptions) {
  if (columnOptions.type) {
    columnOptions.type = resolveDbType(columnOptions.type);
  }
  return Column(columnOptions);
}

/**
 * For bigint columns holding sizes past 2 GB: Postgres hands bigints back
 * as text, so they are read back as numbers.
 */
export const bigNumber = {
  to: (value?: number | null) => value,
  from: (value?: string | number | null) =>
    value === null || value === undefined ? value : Number(value),
};
