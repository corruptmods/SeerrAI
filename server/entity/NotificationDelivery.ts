import { resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity()
@Unique(['requestId', 'type', 'userId', 'episodeKey'])
export class NotificationDelivery {
  @PrimaryGeneratedColumn()
  public id: number;

  @Index()
  @Column()
  public requestId: number;

  @Column()
  public type: number;

  /** Recipient. 0 means the request's original requester. */
  @Column({ default: 0 })
  public userId: number;

  /**
   * Distinguishes per-episode notifications, e.g. "S02E05". Empty for
   * whole-media notifications. Not nullable: Postgres treats NULLs as
   * distinct in a UNIQUE constraint, which would silently defeat the
   * de-duplication this table exists for.
   */
  @Column({ default: '' })
  public episodeKey: string;

  @CreateDateColumn({ type: resolveDbType('datetime') })
  public sentAt: Date;

  constructor(init?: Partial<NotificationDelivery>) {
    Object.assign(this, init);
  }
}

export default NotificationDelivery;
