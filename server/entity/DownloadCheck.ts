import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/** Before download, or after download when the import is stuck. */
export type CheckStage = 'grab' | 'import';

/**
 * What followed a reject (`params.after`), besides the blocklist:
 *
 * - search: the server searched again for what's missing
 * - byTitle: Backfill searches by episode title (searching by the release's
 *   number would find it again)
 * - noSearch: not searched by that number, and Backfill doesn't search
 * - none: nothing missing, so no search
 */
export type RejectAfter = 'search' | 'byTitle' | 'noSearch' | 'none';

/**
 * What Download Check found:
 *
 * - program, archive, noVideo, sample: the torrent's files
 * - early: grabbed a day or more before the episode aired
 * - otherTitle: a different show, film or version than it's filed under
 * - renumbered: the right show, numbered differently (`params.episode`)
 * - notUpgrade: no better than the existing file
 * - moreEpisodes: the existing file holds more episodes
 * - duplicate: a better copy is in the queue
 * - sameTitle: named differently, but the title it's filed under
 * - unsureTitle: matched only on the indexer's id; the name doesn't confirm it
 * - xem, sampleUnsure, unparsed: blocked for something an import can get past
 * - badFiles: nothing the server can import
 * - partial: part of a pack arrived; the rest wasn't in it
 * - alreadyImported: its files are already imported
 * - unknown: blocked for a reason Download Check doesn't know
 * - unmapped: right title, but files can't be mapped to episodes
 */
export type CheckFinding =
  | 'program'
  | 'archive'
  | 'noVideo'
  | 'sample'
  | 'early'
  | 'otherTitle'
  | 'renumbered'
  | 'notUpgrade'
  | 'moreEpisodes'
  | 'duplicate'
  | 'sameTitle'
  | 'unsureTitle'
  | 'xem'
  | 'sampleUnsure'
  | 'unparsed'
  | 'badFiles'
  | 'partial'
  | 'alreadyImported'
  | 'unknown'
  | 'unmapped';

/**
 * - reject: removed from queue and client, blocklisted, and searched again
 *   while anything it was for is missing
 * - drop: removed from queue and client, nothing else (a better copy is coming)
 * - clear: removed from the queue but left in the client (imported, fully or as
 *   far as possible), and anything missing searched for
 * - import: imported, telling the server which episodes or movie it is
 * - review: left for an admin
 */
export type CheckAction = 'reject' | 'drop' | 'clear' | 'import' | 'review';

/**
 * - would: found with Report only on; nothing done
 * - waiting: left for an admin (review)
 * - done, failed: acted on
 * - dismissed: an admin chose to leave it
 * - gone: left the queue before anything was done
 */
export type CheckStatus =
  | 'would'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'dismissed'
  | 'gone';

/**
 * A download Download Check flagged, and what it did. One row per download and
 * stage: judged once before download and again if its import gets stuck.
 */
@Entity()
@Unique(['app', 'serverId', 'downloadKey', 'stage'])
export class DownloadCheck {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'varchar' })
  public app: 'sonarr' | 'radarr';

  @Column()
  public serverId: number;

  /** The download client's id, or the release while a delay holds it. */
  @Column({ type: 'varchar' })
  public downloadKey: string;

  @Column({ type: 'varchar' })
  public stage: CheckStage;

  /** The release name. */
  @Column({ type: 'varchar' })
  public title: string;

  /** Sonarr's series or Radarr's movie id. */
  @Column()
  public itemId: number;

  @Column({ type: 'varchar' })
  public itemTitle: string;

  /** "S01E03", "S02 (10 episodes)"; empty for a movie. */
  @Column({ type: 'varchar', default: '' })
  public episodes: string;

  @Column({ type: 'varchar', nullable: true })
  public poster?: string | null;

  @Column({ type: 'varchar' })
  public finding: CheckFinding;

  @Column({ type: 'varchar' })
  public action: CheckAction;

  @Index()
  @Column({ type: 'varchar' })
  public status: CheckStatus;

  /** JSON details for displaying the finding (files, hours, qualities). */
  @Column({ type: 'text', default: '{}' })
  public params: string;

  /** The server's message for a blocked import. */
  @Column({ type: 'text', default: '' })
  public detail: string;

  /** Why acting on it failed. */
  @Column({ type: 'text', nullable: true })
  public error?: string | null;

  @Index()
  @DbAwareColumn({ type: 'datetime' })
  public createdAt: Date;

  @DbAwareColumn({ type: 'datetime' })
  public updatedAt: Date;

  constructor(init?: Partial<DownloadCheck>) {
    Object.assign(this, init);
  }
}

export default DownloadCheck;
