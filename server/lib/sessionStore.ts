import type { Session } from '@server/entity/Session';
import { sessionTtlSeconds } from '@server/lib/signIn';
import logger from '@server/logger';
import { TypeormStore } from 'connect-typeorm/out';
import type { Store } from 'express-session';
import type { Repository } from 'typeorm';

/** Where sessions are kept: the database, through TypeORM. */
export const sessionStoreFor = (repository: Repository<Session>): Store =>
  new TypeormStore({
    cleanupLimit: 2,
    // Signed-out sessions only ever hold a passkey challenge: they need
    // minutes, not a month, and anyone can create them.
    ttl: (_store, session) => sessionTtlSeconds(session),
    // Without this, one failed query (Postgres briefly out of connections)
    // marks the store gone for good, and from then on nobody can sign in
    // until Seerr restarts. The failed request still fails; the next one
    // tries the database again.
    onError: (_store, error) =>
      logger.error('Session store query failed', {
        label: 'Server',
        errorMessage: error instanceof Error ? error.message : String(error),
      }),
  }).connect(repository) as Store;
