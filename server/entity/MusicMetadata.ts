import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Persisted responses from MusicBrainz and other music services: MusicBrainz
 * allows one request a second, and a cold start shouldn't re-fetch every artist
 * on the server.
 *
 * Keyed by query, e.g. `artist:<id>`, `rg:<id>`,
 * `rg-list:<artist>:<types>:<page>`, `release-rg:<id>`, `tracks:<id>`,
 * `artist-image:<id>`. Database maintenance clears expired rows.
 */
@Entity()
class MusicMetadata {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  public key: string;

  /** The response, as JSON. */
  @Column({ type: 'text' })
  public data: string;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public fetchedAt: Date;

  /** When to re-fetch; kept forever when null. */
  @DbAwareColumn({ type: 'datetime', nullable: true })
  @Index()
  public expiresAt?: Date | null;

  constructor(init?: Partial<MusicMetadata>) {
    Object.assign(this, init);
  }
}

export default MusicMetadata;
