import type { SeriesType } from '@server/constants/seriesType';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity()
class OverrideRule {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'int', nullable: true })
  public radarrServiceId?: number;

  @Column({ type: 'int', nullable: true })
  public sonarrServiceId?: number;

  @Column({ nullable: true })
  public users?: string;

  @Column({ nullable: true })
  public genre?: string;

  @Column({ nullable: true })
  public language?: string;

  @Column({ nullable: true })
  public keywords?: string;

  @Column({ type: 'int', nullable: true })
  public profileId?: number;

  @Column({ nullable: true })
  public rootFolder?: string;

  @Column({ nullable: true })
  public tags?: string;

  /** Sonarr only: the series type a matching request is added with. */
  @Column({ type: 'varchar', nullable: true })
  public seriesType?: SeriesType | null;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<OverrideRule>) {
    Object.assign(this, init);
  }
}

export default OverrideRule;
