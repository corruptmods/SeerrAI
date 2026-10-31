import type { ArrKind } from '@server/lib/quality/types';
import { resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * A movie or series moved to a looser preset because nothing was grabbed
 * for it in a long while (lib/quality/stepDown); it goes back to its own
 * profile once something is.
 */
@Entity()
@Unique('UNIQUE_QUALITY_STEP_DOWN', ['serverKind', 'serverId', 'arrId'])
export class QualityStepDown {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'varchar' })
  public serverKind: ArrKind;

  @Column({ type: 'integer' })
  public serverId: number;

  /** The movie's or series' id in Radarr or Sonarr. */
  @Column({ type: 'integer' })
  public arrId: number;

  @Column({ type: 'varchar' })
  public title: string;

  @Column({ type: 'integer' })
  public fromProfileId: number;

  @Column({ type: 'integer' })
  public toProfileId: number;

  @CreateDateColumn({ type: resolveDbType('datetime') })
  public createdAt: Date;

  constructor(init?: Partial<QualityStepDown>) {
    Object.assign(this, init);
  }
}

export default QualityStepDown;
