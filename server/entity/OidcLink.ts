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
 * A user's single sign-on provider account linked to their account here. Users
 * are only found by provider and the provider's id for them (`sub`), never by
 * email. Links survive a provider being disabled or removed (they just can't
 * sign in), and an issuer URL change (for links made at the old issuer).
 */
@Entity()
@Index('IDX_oidc_link_provider_sub', ['provider', 'sub'], { unique: true })
@Index('IDX_oidc_link_user_provider', ['user', 'provider'], { unique: true })
export class OidcLink {
  @PrimaryGeneratedColumn()
  public id: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  public user: User;

  /** The provider's id in Settings → Users → Single Sign-On. */
  @Column({ type: 'varchar' })
  public provider: string;

  /** The provider's permanent id for this user. */
  @Column({ type: 'varchar' })
  public sub: string;

  /**
   * The provider's issuer URL when linked, without a trailing slash. A `sub`
   * only identifies someone at the issuer that issued it, so the link is only
   * used while the provider keeps this issuer. Empty for links made before this
   * was recorded: they adopt the provider's issuer at their next sign-in, or
   * the old one when the issuer changes.
   */
  @Column({ type: 'varchar', nullable: true })
  public issuer?: string | null;

  /** Their username there, for Linked Accounts; refreshed on each sign-in. */
  @Column({ type: 'varchar', nullable: true })
  public username?: string | null;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  constructor(init?: Partial<OidcLink>) {
    Object.assign(this, init);
  }
}

export default OidcLink;
