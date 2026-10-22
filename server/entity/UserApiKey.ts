import type { ApiKeyScope } from '@server/constants/apiKeys';
import { User } from '@server/entity/User';
import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A personal API key: lets an app or script (a phone app, Home Assistant)
 * act as the person who made it, with exactly their permissions. Only a
 * hash of the key is kept; the key itself is shown once, when it is made.
 * See lib/personalApiKeys.
 */
@Entity()
export class UserApiKey {
  @PrimaryGeneratedColumn()
  public id: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'userId' })
  public user: User;

  @Column()
  @Index()
  public userId: number;

  /**
   * The short id written into the key after `sai_`, also shown in the list
   * so people can tell their keys apart. What a key is looked up by.
   */
  @Column({ type: 'varchar', unique: true })
  public publicId: string;

  /** SHA-256 of the whole key, hex. */
  @Column({ type: 'varchar', select: false })
  public secretHash: string;

  /** What it is for, as its owner named it ("Home Assistant"). */
  @Column({ type: 'varchar' })
  public name: string;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  /** When it stops working; never when empty. */
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public expiresAt?: Date | null;

  /** Written at most once a minute, not on every request. */
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastUsedAt?: Date | null;

  /**
   * What it may do: empty for everything its owner may, 'siri' for Siri's
   * reports alone (/api/v1/now-playing). A Siri key is made on the Siri
   * page, not listed with the others, and works whether or not people may
   * make their own keys.
   */
  @Column({ type: 'varchar', nullable: true })
  public scope?: ApiKeyScope | null;

  constructor(init?: Partial<UserApiKey>) {
    Object.assign(this, init);
  }
}

export default UserApiKey;
