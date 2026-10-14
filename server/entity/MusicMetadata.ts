import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * What MusicBrainz and the other music services answered, kept so it
 * survives a restart: MusicBrainz allows one request a second, and a cold
 * start should not have to ask again for every artist on the server.
 *
 * Keyed by what was asked, e.g. `artist:<id>`, `rg:<id>`,
 * `rg-list:<artist>:<types>:<page>`, `release-rg:<id>`, `tracks:<id>`,
 * `artist-image:<id>`. Database maintenance clears expired rows.
 */
@Entity()
class MusicMetadata {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  public key: string;

  /** The answer, as JSON. */
  @Column({ type: 'text' })
  public data: string;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public fetchedAt: Date;

  /** When it should be asked for again. Kept forever when null. */
  @DbAwareColumn({ type: 'datetime', nullable: true })
  @Index()
  public expiresAt?: Date | null;

  constructor(init?: Partial<MusicMetadata>) {
    Object.assign(this, init);
  }
}

export default MusicMetadata;
