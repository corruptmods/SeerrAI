import { User } from '@server/entity/User';
import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * Someone wants a series from here on: each season from `fromSeason` onward
 * is requested for them as it premieres, and nothing before it.
 */
@Entity()
@Unique('UNIQUE_FUTURE_SEASON_SUBSCRIPTION', ['user', 'tmdbId'])
export class FutureSeasonSubscription {
  @PrimaryGeneratedColumn()
  public id: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @Index()
  public user: User;

  @Column()
  @Index()
  public tmdbId: number;

  /** The next season to request. Moves on each time one is requested. */
  @Column({ type: 'int' })
  public fromSeason: number;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  constructor(init?: Partial<FutureSeasonSubscription>) {
    Object.assign(this, init);
  }
}

export default FutureSeasonSubscription;
