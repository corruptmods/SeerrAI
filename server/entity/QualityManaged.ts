import type { ArrKind } from '@server/lib/quality/types';
import { resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

export type QualityItemKind = 'profile' | 'format';

/**
 * A quality profile or custom format Seerr AI created and manages in a Radarr
 * or Sonarr (Settings → Quality), by its id there. Nothing else on a server is
 * ever changed. The fingerprint is of what Seerr AI last wrote, so edits made
 * in Radarr or Sonarr show.
 */
@Entity()
@Unique('UNIQUE_QUALITY_MANAGED', ['serverKind', 'serverId', 'itemKind', 'key'])
export class QualityManaged {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'varchar' })
  public serverKind: ArrKind;

  @Index()
  @Column({ type: 'integer' })
  public serverId: number;

  @Column({ type: 'varchar' })
  public itemKind: QualityItemKind;

  /** A profile's preset, or a format's key (lib/quality/build). */
  @Column({ type: 'varchar' })
  public key: string;

  /** Its id in Radarr or Sonarr. */
  @Column({ type: 'integer' })
  public arrId: number;

  @Column({ type: 'varchar' })
  public fingerprint: string;

  /**
   * An admin kept an edit made in Radarr or Sonarr: it's left as is and skipped
   * until reverted.
   */
  @Column({ type: 'boolean', default: false })
  public keptAsEdited: boolean;

  @CreateDateColumn({ type: resolveDbType('datetime') })
  public createdAt: Date;

  @UpdateDateColumn({ type: resolveDbType('datetime') })
  public updatedAt: Date;

  constructor(init?: Partial<QualityManaged>) {
    Object.assign(this, init);
  }
}

export default QualityManaged;
