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
 * Someone's account on a single sign-on provider, linked to their account
 * here. People are only ever found by the provider and the provider's own
 * id for them (`sub`), never by email. A provider that is switched off or
 * removed keeps its links; they just can't be used to sign in. So does one
 * whose issuer URL changed, for links made at the old issuer.
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

  /** The provider's own id for this person, which never changes there. */
  @Column({ type: 'varchar' })
  public sub: string;

  /**
   * The provider's issuer URL when this was linked, without a slash at the
   * end. A `sub` only means someone at the issuer that gave it, so a link
   * is only used while the provider still has this issuer. Empty for links
   * made before it was recorded: they take the provider's issuer the next
   * time they sign someone in, or the old one when the issuer is changed.
   */
  @Column({ type: 'varchar', nullable: true })
  public issuer?: string | null;

  /** Their name there, for Linked Accounts; refreshed on each sign-in. */
  @Column({ type: 'varchar', nullable: true })
  public username?: string | null;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  constructor(init?: Partial<OidcLink>) {
    Object.assign(this, init);
  }
}

export default OidcLink;
