import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { isPgsql } from '@server/utils/dbType';

/**
 * Saves the first account, made when there are none, as the owner: id 1,
 * which the owner's checks rely on. TypeORM leaves a generated id out of a
 * Postgres insert, so with no accounts Postgres's counter is put back to 1
 * first (after accounts were deleted it would go on from the last one). SQLite
 * writes the id as given.
 */
export const saveFirstOwner = async (user: User): Promise<User> => {
  const repository = getRepository(User);
  user.id = 1;
  if (isPgsql && !(await repository.count())) {
    const table = repository.metadata.tablePath;
    await repository.query(
      `SELECT setval(pg_get_serial_sequence($1, 'id'), 1, false)`,
      [`"${table}"`]
    );
  }
  return repository.save(user);
};
