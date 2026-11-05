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
 * An item's state in Radarr or Sonarr before an apply changed it; null when the
 * apply created it. Undo restores these.
 */
export interface QualityBefore {
  itemKind: 'profile' | 'format' | 'delay' | 'requests';
  key: string;
  arrId: number;
  before: Record<string, unknown> | null;
}

/** A title an apply moved onto one of Seerr AI's profiles. */
export interface QualityMovedTitle {
  arrId: number;
  fromProfileId: number;
}

/**
 * One apply of Seerr AI's quality profiles to a server, for History and Undo: a
 * one-line summary, and the copies to restore.
 */
@Entity()
export class QualityApply {
  @PrimaryGeneratedColumn()
  public id: number;

  @Index()
  @Column({ type: 'varchar' })
  public serverKind: ArrKind;

  @Index()
  @Column({ type: 'integer' })
  public serverId: number;

  /** The admin who applied it; null for an automatic TRaSH Guides update. */
  @Column({ type: 'integer', nullable: true })
  public userId: number | null;

  /** What it did, as the page lists it (lib/quality/engine). */
  @Column({ type: 'simple-json' })
  public summary: { created: number; updated: number; trash?: boolean };

  @Column({ type: 'simple-json' })
  public befores: QualityBefore[];

  @Column({ type: 'simple-json', default: '[]' })
  public moved: QualityMovedTitle[];

  @Column({ type: resolveDbType('datetime'), nullable: true })
  public undoneAt: Date | null;

  @CreateDateColumn({ type: resolveDbType('datetime') })
  public createdAt: Date;

  constructor(init?: Partial<QualityApply>) {
    Object.assign(this, init);
  }
}

export default QualityApply;
