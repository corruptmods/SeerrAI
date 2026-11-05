import { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';

/**
 * Fills in `requestCount` for a set of users with one grouped query.
 *
 * Not `@RelationCount`: it runs parallel count queries on one connection
 * (pg's "client is already executing a query" deprecation warning), one per
 * user.
 */
export const attachRequestCounts = async (users: User[]): Promise<void> => {
  if (!users.length) {
    return;
  }

  const rows = await getRepository(MediaRequest)
    .createQueryBuilder('request')
    .select('request.requestedById', 'userId')
    .addSelect('COUNT(request.id)', 'count')
    .where('request.requestedById IN (:...userIds)', {
      userIds: users.map((user) => user.id),
    })
    .groupBy('request.requestedById')
    .getRawMany<{ userId: number; count: string }>();

  const counts = new Map(
    rows.map((row) => [Number(row.userId), Number(row.count)])
  );

  for (const user of users) {
    user.requestCount = counts.get(user.id) ?? 0;
  }
};

/** Single-user form of attachRequestCounts. */
export const attachRequestCount = async (user: User): Promise<void> =>
  attachRequestCounts([user]);

export default attachRequestCounts;
