import type { ArrKind } from '@server/lib/quality/types';
import { resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A release Seerr AI grabbed through Radarr or Sonarr itself (Autofix),
 * with what it was chosen over: Radarr and Sonarr keep only the release
 * grabbed, so this is the one place a "why it won" can come from.
 */
@Entity()
export class QualityGrabNote {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'varchar' })
  public serverKind: ArrKind;

  @Column({ type: 'integer' })
  public serverId: number;

  @Index()
  @Column({ type: 'varchar' })
  public title: string;

  @Column({ type: 'varchar', nullable: true })
  public protocol: 'usenet' | 'torrent' | null;

  /**
   * Another release of the same quality and score was on offer, over the
   * other protocol: the grab won a tie.
   */
  @Column({ type: 'boolean', default: false })
  public wonTie: boolean;

  @CreateDateColumn({ type: resolveDbType('datetime') })
  public createdAt: Date;

  constructor(init?: Partial<QualityGrabNote>) {
    Object.assign(this, init);
  }
}

export default QualityGrabNote;
