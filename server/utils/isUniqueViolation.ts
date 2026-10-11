/**
 * Whether a database error is a unique-constraint violation, on either
 * engine. Postgres and SQLite report it differently, and checking only one
 * of them (SQLite's errno 19, say) silently misclassifies it on the other.
 */
export const isUniqueViolation = (e: unknown): boolean => {
  if (!e || typeof e !== 'object') {
    return false;
  }

  const error = e as {
    code?: string;
    errno?: number;
    message?: string;
    driverError?: { code?: string; errno?: number; message?: string };
  };

  const driver = error.driverError ?? error;

  // Postgres: unique_violation
  if (driver.code === '23505') {
    return true;
  }

  // SQLite: SQLITE_CONSTRAINT (19), reported via message or errno
  if (driver.errno === 19 || driver.code === 'SQLITE_CONSTRAINT') {
    return true;
  }

  const message = driver.message ?? error.message ?? '';

  return /UNIQUE constraint failed|duplicate key value/i.test(message);
};
