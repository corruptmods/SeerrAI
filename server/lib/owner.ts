import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';

/** The server owner (first account), whom automatic steps act as. */
export const owner = (): Promise<User | null> =>
  getRepository(User).findOne({ where: { id: 1 } });
