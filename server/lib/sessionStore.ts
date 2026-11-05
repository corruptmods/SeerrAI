import type { Session } from '@server/entity/Session';
import { sessionTtlSeconds } from '@server/lib/signIn';
import logger from '@server/logger';
import { TypeormStore } from 'connect-typeorm/out';
import type { Store } from 'express-session';
import type { Repository } from 'typeorm';

/** Session store backed by the database via TypeORM. */
export const sessionStoreFor = (repository: Repository<Session>): Store =>
  new TypeormStore({
    cleanupLimit: 2,
    // Signed-out sessions only hold a passkey challenge: they need minutes, not
    // a month, and anyone can create them.
    ttl: (_store, session) => sessionTtlSeconds(session),
    // Without this, one failed query (Postgres briefly out of connections)
    // marks the store gone for good and nobody can sign in until restart. The
    // failed request still fails; the next retries the database.
    onError: (_store, error) =>
      logger.error('Session store query failed', {
        label: 'Server',
        errorMessage: error instanceof Error ? error.message : String(error),
      }),
  }).connect(repository) as Store;
