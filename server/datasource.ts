import AgentRun from '@server/entity/AgentRun';
import AiSpend from '@server/entity/AiSpend';
import AiUsage from '@server/entity/AiUsage';
import BackfillCandidate from '@server/entity/BackfillCandidate';
import BackfillJob from '@server/entity/BackfillJob';
import BackfillSeries from '@server/entity/BackfillSeries';
import { Blocklist } from '@server/entity/Blocklist';
import DiscoverSlider from '@server/entity/DiscoverSlider';
import Episode from '@server/entity/Episode';
import EpisodeRequest from '@server/entity/EpisodeRequest';
import FutureSeasonSubscription from '@server/entity/FutureSeasonSubscription';
import Issue from '@server/entity/Issue';
import IssueComment from '@server/entity/IssueComment';
import Media from '@server/entity/Media';
import MediaDeletion from '@server/entity/MediaDeletion';
import MediaEvent from '@server/entity/MediaEvent';
import {
  MediaList,
  MediaListItem,
  MediaListMember,
  MediaListWatchSuggestion,
} from '@server/entity/MediaList';
import { MediaRequest } from '@server/entity/MediaRequest';
import { MediaRequestWatcher } from '@server/entity/MediaRequestWatcher';
import { NotificationDelivery } from '@server/entity/NotificationDelivery';
import OverrideRule from '@server/entity/OverrideRule';
import RemovedPlexAccount from '@server/entity/RemovedPlexAccount';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import { Session } from '@server/entity/Session';
import { User } from '@server/entity/User';
import UserPasskey from '@server/entity/UserPasskey';
import { UserPushSubscription } from '@server/entity/UserPushSubscription';
import { UserSettings } from '@server/entity/UserSettings';
import { Watchlist } from '@server/entity/Watchlist';
import { WatchlistSyncEntry } from '@server/entity/WatchlistSyncEntry';
import { WatchlistSyncEntrySeason } from '@server/entity/WatchlistSyncEntrySeason';
import { IssueCommentSubscriber } from '@server/subscriber/IssueCommentSubscriber';
import { IssueSubscriber } from '@server/subscriber/IssueSubscriber';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { MediaSubscriber } from '@server/subscriber/MediaSubscriber';
import { isPgsql } from '@server/utils/dbType';
import fs from 'fs';
import type { TlsOptions } from 'tls';
import type { DataSourceOptions, EntityTarget, Repository } from 'typeorm';
import { DataSource } from 'typeorm';

const DB_SSL_PREFIX = 'DB_SSL_';

const entities = [
  AgentRun,
  AiSpend,
  AiUsage,
  BackfillCandidate,
  BackfillJob,
  BackfillSeries,
  Blocklist,
  DiscoverSlider,
  Issue,
  IssueComment,
  Episode,
  EpisodeRequest,
  FutureSeasonSubscription,
  Media,
  MediaDeletion,
  MediaEvent,
  MediaList,
  MediaListItem,
  MediaListMember,
  MediaListWatchSuggestion,
  MediaRequest,
  MediaRequestWatcher,
  NotificationDelivery,
  OverrideRule,
  RemovedPlexAccount,
  Season,
  SeasonRequest,
  Session,
  User,
  UserPasskey,
  UserPushSubscription,
  UserSettings,
  Watchlist,
  WatchlistSyncEntry,
  WatchlistSyncEntrySeason,
];

const subscribers = [
  IssueCommentSubscriber,
  IssueSubscriber,
  MediaRequestSubscriber,
  MediaSubscriber,
];

function boolFromEnv(envVar: string, defaultVal = false) {
  if (process.env[envVar]) {
    return process.env[envVar]?.toLowerCase() === 'true';
  }
  return defaultVal;
}

function intFromEnv(envVar: string, defaultVal?: number): number | undefined {
  const val = process.env[envVar];
  if (val) {
    const parsed = parseInt(val, 10);
    return isNaN(parsed) ? defaultVal : parsed;
  }
  return defaultVal;
}

function stringOrReadFileFromEnv(envVar: string): Buffer | string | undefined {
  if (process.env[envVar]) {
    return process.env[envVar];
  }
  const filePath = process.env[`${envVar}_FILE`];
  if (filePath) {
    return fs.readFileSync(filePath);
  }
  return undefined;
}

function buildSslConfig(): TlsOptions | undefined {
  if (process.env.DB_USE_SSL?.toLowerCase() !== 'true') {
    return undefined;
  }
  return {
    rejectUnauthorized: boolFromEnv(
      `${DB_SSL_PREFIX}REJECT_UNAUTHORIZED`,
      true
    ),
    ca: stringOrReadFileFromEnv(`${DB_SSL_PREFIX}CA`),
    key: stringOrReadFileFromEnv(`${DB_SSL_PREFIX}KEY`),
    cert: stringOrReadFileFromEnv(`${DB_SSL_PREFIX}CERT`),
  };
}

const testConfig: DataSourceOptions = {
  type: 'sqlite',
  database: ':memory:',
  synchronize: true,
  dropSchema: true,
  logging: boolFromEnv('DB_LOG_QUERIES'),
  entities,
  migrations: ['server/migration/sqlite/**/*.ts'],
  subscribers,
};

const devConfig: DataSourceOptions = {
  type: 'sqlite',
  database: process.env.CONFIG_DIRECTORY
    ? `${process.env.CONFIG_DIRECTORY}/db/db.sqlite3`
    : 'config/db/db.sqlite3',
  synchronize: true,
  migrationsRun: false,
  logging: boolFromEnv('DB_LOG_QUERIES'),
  enableWAL: true,
  entities,
  migrations: ['server/migration/sqlite/**/*.ts'],
  subscribers,
};

const prodConfig: DataSourceOptions = {
  type: 'sqlite',
  database: process.env.CONFIG_DIRECTORY
    ? `${process.env.CONFIG_DIRECTORY}/db/db.sqlite3`
    : 'config/db/db.sqlite3',
  synchronize: false,
  migrationsRun: false,
  logging: boolFromEnv('DB_LOG_QUERIES'),
  enableWAL: true,
  entities,
  migrations: ['dist/migration/sqlite/**/*.js'],
  subscribers,
};

const postgresDevConfig: DataSourceOptions = {
  type: 'postgres',
  host: process.env.DB_SOCKET_PATH || process.env.DB_HOST,
  port: process.env.DB_SOCKET_PATH
    ? undefined
    : parseInt(process.env.DB_PORT ?? '5432'),
  username: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME ?? 'seerr',
  ssl: buildSslConfig(),
  poolSize: intFromEnv('DB_POOL_SIZE', 25),
  // Bounds pool acquisition waits so exhaustion surfaces as errors instead of a silent hang
  connectTimeoutMS: intFromEnv('DB_CONNECT_TIMEOUT_MS', 30000),
  synchronize: false,
  migrationsRun: true,
  logging: boolFromEnv('DB_LOG_QUERIES'),
  entities,
  migrations: ['server/migration/postgres/**/*.ts'],
  subscribers,
};

const postgresProdConfig: DataSourceOptions = {
  type: 'postgres',
  host: process.env.DB_SOCKET_PATH || process.env.DB_HOST,
  port: process.env.DB_SOCKET_PATH
    ? undefined
    : parseInt(process.env.DB_PORT ?? '5432'),
  username: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME ?? 'seerr',
  ssl: buildSslConfig(),
  poolSize: intFromEnv('DB_POOL_SIZE', 25),
  // Bounds pool acquisition waits so exhaustion surfaces as errors instead of a silent hang
  connectTimeoutMS: intFromEnv('DB_CONNECT_TIMEOUT_MS', 30000),
  synchronize: false,
  migrationsRun: false,
  logging: boolFromEnv('DB_LOG_QUERIES'),
  entities,
  migrations: ['dist/migration/postgres/**/*.js'],
  subscribers,
};

/*
 * Opt-in: DB_TYPE=postgres runs the suite against a real Postgres rather than
 * in-memory SQLite. Production runs Postgres; tests only ever ran SQLite, and
 * that gap let through a datetime column Postgres rejects and a watchlist
 * loop that reproduced cleanly on SQLite. Point DB_HOST and friends at a
 * disposable database — the schema is dropped on every run.
 */
const postgresTestConfig: DataSourceOptions = {
  type: 'postgres',
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: parseInt(process.env.DB_PORT ?? '5432'),
  username: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME ?? 'seerr_test',
  // No idle reaping. The pool times out idle connections with setTimeout and
  // cancels that on checkout with clearTimeout; a test that fakes timers can
  // check a connection out with the fake clearTimeout, leaving the real
  // timer to close it ten seconds later in the middle of another test. Idle
  // connections instead just stop holding the test process open.
  extra: { idleTimeoutMillis: 0, allowExitOnIdle: true },
  synchronize: true,
  dropSchema: true,
  logging: boolFromEnv('DB_LOG_QUERIES'),
  entities,
  migrations: ['server/migration/postgres/**/*.ts'],
  subscribers,
};

function getDataSource(): DataSourceOptions {
  if (process.env.NODE_ENV === 'test') {
    return isPgsql ? postgresTestConfig : testConfig;
  } else if (process.env.NODE_ENV === 'production') {
    return isPgsql ? postgresProdConfig : prodConfig;
  } else {
    return isPgsql ? postgresDevConfig : devConfig;
  }
}

const dataSource = new DataSource(getDataSource());

export const getRepository = <Entity extends object>(
  target: EntityTarget<Entity>
): Repository<Entity> => {
  return dataSource.getRepository(target);
};

export default dataSource;
