import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';

/** The server's owner, the first account: who automatic steps act as. */
export const owner = (): Promise<User | null> =>
  getRepository(User).findOne({ where: { id: 1 } });
