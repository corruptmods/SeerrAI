import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** Status of a song taken from an album. */
export type SongFetchStatus =
  /** Waiting its turn, or for Lidarr to know the album. */
  | 'queued'
  /** Looking for an album release containing the songs. */
  | 'searching'
  | 'downloading'
  /** Lidarr is importing the songs' files. */
  | 'importing'
  | 'done'
  | 'failed';

/** One song's file in the release, and the Lidarr track it becomes. */
export interface SongFetchFile {
  /** The file's index in the torrent or NZB; the client's, once added. */
  index: number;
  /** Its path inside the release (for Soulseek, as the sharer names it). */
  path: string;
  size: number;
  recordingMbid: string;
  trackId: number;
}

/**
 * Songs only on an album, fetched through it: a release is found and downloaded
 * (only the songs' files, for a torrent), Lidarr's manual import takes just
 * those tracks into the album, which stays unmonitored so Lidarr never searches
 * for the rest, and the download is removed. One row per album, for the songs
 * requested from it.
 */
@Entity()
class SongFetch {
  @PrimaryGeneratedColumn()
  public id: number;

  /** The album's MusicBrainz release-group id. */
  @Column({ type: 'varchar' })
  @Index()
  public albumMbid: string;

  @Column({ type: 'varchar' })
  public albumTitle: string;

  @Column({ type: 'varchar' })
  public artistMbid: string;

  @Column({ type: 'varchar' })
  public artistName: string;

  /** The songs' MusicBrainz recording ids. */
  @Column({ type: 'simple-json', default: '[]' })
  public recordings: string[];

  @Column({ type: 'varchar', default: 'queued' })
  public status: SongFetchStatus;

  /** Current progress, in words. */
  @Column({ type: 'varchar', nullable: true })
  public stage: string | null;

  /** Why it failed. */
  @Column({ type: 'varchar', nullable: true })
  public error: string | null;

  /** The Lidarr server's id in Seerr's settings. */
  @Column({ type: 'int' })
  public lidarrId: number;

  @Column({ type: 'int', nullable: true })
  public lidarrArtistId: number | null;

  @Column({ type: 'int', nullable: true })
  public lidarrAlbumId: number | null;

  /** The Lidarr album release the songs are imported into. */
  @Column({ type: 'int', nullable: true })
  public lidarrReleaseId: number | null;

  /** The chosen release, as Prowlarr found it, or a Soulseek sharer's files. */
  @Column({ type: 'simple-json', nullable: true })
  public release: {
    guid: string;
    title: string;
    indexer: string;
    indexerId: number;
    protocol: 'torrent' | 'usenet' | 'soulseek';
    size: number;
    downloadUrl?: string;
    magnetUrl?: string;
    infoHash?: string;
    /** The Soulseek sharer the files come from. */
    username?: string;
    /** Where slskd puts them, under its downloads folder. */
    folder?: string;
  } | null;

  @Column({ type: 'simple-json', default: '[]' })
  public files: SongFetchFile[];

  /** The download client's id in Seerr's settings. */
  @Column({ type: 'int', nullable: true })
  public clientId: number | null;

  /**
   * The torrent hash or Usenet job id; for Soulseek, the requested slskd
   * batches, comma-separated.
   */
  @Column({ type: 'varchar', nullable: true })
  public downloadId: string | null;

  /** Lidarr's import command. */
  @Column({ type: 'int', nullable: true })
  public commandId: number | null;

  /**
   * Searches that found no release with the songs. Indexers come and go (busy,
   * rate-limited), so it retries a few times before giving up.
   */
  @Column({ type: 'int', default: 0 })
  public searches: number;

  /** When to search again after a search found nothing. */
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public searchAgainAt: Date | null;

  /** Failed releases, never retried for this album. */
  @Column({ type: 'simple-json', default: '[]' })
  public tried: string[];

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public startedAt: Date | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public finishedAt: Date | null;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<SongFetch>) {
    Object.assign(this, init);
  }
}

export default SongFetch;
