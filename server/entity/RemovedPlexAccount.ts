import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * A Plex account whose Seerr user an admin deleted.
 *
 * Otherwise the automatic Plex user import would recreate it on its next run.
 * Separate from User because the user row is gone. Only matters while no user
 * has this Plex account: a manual import, or its owner signing in, restores it.
 */
@Entity()
export class RemovedPlexAccount {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ unique: true })
  public plexId: number;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public removedAt: Date;

  constructor(init?: Partial<RemovedPlexAccount>) {
    Object.assign(this, init);
  }
}

export default RemovedPlexAccount;
