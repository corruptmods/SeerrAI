import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * A notification button's one-time token that has been used, by its random
 * id, so the same button can't act twice (see lib/requestActionTokens). Kept
 * only until the token would have expired anyway.
 */
@Entity()
export class UsedActionToken {
  @PrimaryColumn({ type: 'varchar' })
  public id: string;

  @DbAwareColumn({ type: 'datetime' })
  @Index()
  public expiresAt: Date;

  constructor(init?: Partial<UsedActionToken>) {
    Object.assign(this, init);
  }
}

export default UsedActionToken;
