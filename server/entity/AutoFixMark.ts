import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Auto-fix's daily allowances in use and titles fixed lately, so its limits
 * hold across restarts. Only the last day is kept.
 */
@Entity()
export class AutoFixMark {
  @PrimaryGeneratedColumn()
  public id: number;

  /** "use:fix:12:2026-11-05" for an allowance, "held:…" for a title's fix. */
  @Column({ type: 'varchar', unique: true })
  public key: string;

  /** Allowances used; 0 for a held fix. */
  @Column({ type: 'integer', default: 0 })
  public count: number;

  @Index()
  @DbAwareColumn({ type: 'datetime' })
  public at: Date;

  constructor(init?: Partial<AutoFixMark>) {
    Object.assign(this, init);
  }
}

export default AutoFixMark;
