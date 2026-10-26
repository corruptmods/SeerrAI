import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** Where a song taken from an album is. */
export type SongFetchStatus =
  /** Waiting its turn, or for Lidarr to know the album. */
  | 'queued'
  /** Looking for a release of the album that has the songs. */
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
  /** Its path inside the release. */
  path: string;
  size: number;
  recordingMbid: string;
  trackId: number;
}

/**
 * Songs only on an album, fetched through it: a release of the album is
 * found and downloaded (only the songs' files, for a torrent), Lidarr's
 * manual import takes just those tracks into the album, which stays
 * unmonitored so Lidarr never goes looking for the rest, and the download
 * is removed. One for each album, for the songs asked for from it.
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

  /** The songs it fetches: their MusicBrainz recording ids. */
  @Column({ type: 'simple-json', default: '[]' })
  public recordings: string[];

  @Column({ type: 'varchar', default: 'queued' })
  public status: SongFetchStatus;

  /** What it is doing now, in words. */
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

  /** The album's release in Lidarr the songs are taken into. */
  @Column({ type: 'int', nullable: true })
  public lidarrReleaseId: number | null;

  /** The release taken, as Prowlarr found it. */
  @Column({ type: 'simple-json', nullable: true })
  public release: {
    guid: string;
    title: string;
    indexer: string;
    indexerId: number;
    protocol: 'torrent' | 'usenet';
    size: number;
    downloadUrl?: string;
    magnetUrl?: string;
    infoHash?: string;
  } | null;

  @Column({ type: 'simple-json', default: '[]' })
  public files: SongFetchFile[];

  /** The download client's id in Seerr's settings. */
  @Column({ type: 'int', nullable: true })
  public clientId: number | null;

  /** The torrent's hash, or the Usenet client's job id. */
  @Column({ type: 'varchar', nullable: true })
  public downloadId: string | null;

  /** Lidarr's import command. */
  @Column({ type: 'int', nullable: true })
  public commandId: number | null;

  /** Releases tried that failed, never taken again for this album. */
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
