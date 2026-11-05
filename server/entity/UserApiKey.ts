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
 * A personal API key: lets an app or script (a phone app, Home Assistant) act
 * as its creator with exactly their permissions. Only a hash is stored; the key
 * is shown once at creation. See lib/personalApiKeys.
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
   * The short id after `sai_` in the key, shown in the list so users can tell
   * keys apart. Keys are looked up by it.
   */
  @Column({ type: 'varchar', unique: true })
  public publicId: string;

  /** SHA-256 of the whole key, hex. */
  @Column({ type: 'varchar', select: false })
  public secretHash: string;

  /** Its owner's name for it ("Home Assistant"). */
  @Column({ type: 'varchar' })
  public name: string;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  /** When it expires; never when empty. */
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public expiresAt?: Date | null;

  /** Written at most once a minute, not on every request. */
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastUsedAt?: Date | null;

  /**
   * Restrictions: empty for everything its owner may do, 'siri' for Siri
   * reports only (/api/v1/now-playing). Siri keys are made on the Siri page,
   * not listed with the others, and work whether or not personal keys are
   * allowed.
   */
  @Column({ type: 'varchar', nullable: true })
  public scope?: ApiKeyScope | null;

  constructor(init?: Partial<UserApiKey>) {
    Object.assign(this, init);
  }
}

export default UserApiKey;
