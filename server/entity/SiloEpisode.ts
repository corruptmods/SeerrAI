import type { SeenQuality } from '@server/lib/mediaQuality';
import { bigNumber } from '@server/utils/DbColumnHelper';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * An episode Silo has, as Silo scans last listed it. Silo can't list one
 * series' episodes, so the scans keep them here and count a series' seasons
 * from this copy; a recently added scan updates only the series it touched.
 */
@Entity({ name: 'silo_episode' })
export class SiloEpisode {
  /** Silo's content id for the episode. */
  @PrimaryColumn({ type: 'varchar' })
  public contentId: string;

  /** The series' content id. */
  @Index()
  @Column({ type: 'varchar' })
  public seriesId: string;

  /** The libraries it is in (Silo's ids). */
  @Column({ type: 'simple-json' })
  public libraryIds: string[];

  @Column({ type: 'integer' })
  public season: number;

  @Column({ type: 'integer' })
  public episode: number;

  /** It has a standard (below 2160 lines, or not yet probed) file. */
  @Column({ type: 'boolean', default: true })
  public standard: boolean;

  /** It has a 4K file. */
  @Column({ type: 'boolean', default: false })
  public uhd: boolean;

  /** What its files are in, standard and 4K. */
  @Column({ type: 'simple-json', nullable: true })
  public quality?: { standard?: SeenQuality; uhd?: SeenQuality } | null;

  /**
   * When a scan last listed it (ms since the epoch). A full scan forgets only
   * rows not listed since it started, so episodes a recently added scan
   * stored meanwhile stay.
   */
  @Column({ type: 'bigint', default: 0, transformer: bigNumber })
  public seenAt: number;

  constructor(init?: Partial<SiloEpisode>) {
    Object.assign(this, init);
  }
}

export default SiloEpisode;
