import { User } from '@server/entity/User';
import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A passkey someone can sign in with instead of their Plex account. Anyone can
 * have several: one per phone, computer or security key.
 */
@Entity()
export class UserPasskey {
  @PrimaryGeneratedColumn()
  public id: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @Index()
  public user: User;

  /** The credential id, base64url. What a sign-in names. */
  @Column({ type: 'varchar', unique: true })
  public credentialId: string;

  /** The public key, base64url (COSE). */
  @Column({ type: 'text' })
  public publicKey: string;

  /** Signature counter; a counter that goes backwards means a cloned key. */
  @Column({ type: 'bigint', default: 0 })
  public counter: string;

  /** How the browser can reach it (internal, hybrid, usb…), comma-separated. */
  @Column({ type: 'varchar', nullable: true })
  public transports?: string | null;

  /** Synced across devices (iCloud Keychain, Google Password Manager). */
  @Column({ default: false })
  public backedUp: boolean;

  /** What it's called in settings: the device it was made on, until renamed. */
  @Column({ type: 'varchar' })
  public name: string;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastUsedAt?: Date | null;

  constructor(init?: Partial<UserPasskey>) {
    Object.assign(this, init);
  }
}

export default UserPasskey;
