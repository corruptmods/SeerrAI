import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * A Plex account whose Seerr user an admin deleted.
 *
 * The automatic Plex user import would otherwise create it again on its next
 * run, undoing the deletion. Kept apart from User because the user row is
 * gone. It only matters while no user has this Plex account: importing it by
 * hand, or its owner signing in, brings the account back as before.
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
