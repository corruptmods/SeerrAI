import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/** Before it downloads, or once it's downloaded and the import is stuck. */
export type CheckStage = 'grab' | 'import';

/**
 * What came after a reject (`params.after`), besides the blocklist:
 * - search: the server searched again for what's missing
 * - byTitle: Backfill looks by episode title (a search by the release's
 *   number would find it again)
 * - noSearch: not searched by that number, and Backfill doesn't look
 * - none: nothing missing, so nothing searched
 */
export type RejectAfter = 'search' | 'byTitle' | 'noSearch' | 'none';

/**
 * What Download Check found:
 * - program, archive, noVideo, sample: the torrent's files
 * - early: grabbed a day or more before the episode aired
 * - otherTitle: another show, film or version than it's filed under
 * - renumbered: the right show, numbered another way (`params.episode`)
 * - notUpgrade: no better than the file there
 * - moreEpisodes: the file there holds more episodes than this one
 * - duplicate: a better copy of the same is in the queue
 * - sameTitle: named another way, but the title it's filed under
 * - unsureTitle: matched only on the indexer's id; the name doesn't say
 * - xem, sampleUnsure, unparsed: blocked for something an import gets past
 * - badFiles: nothing in it the server can import
 * - partial: some of a pack came in, the rest wasn't in it
 * - alreadyImported: its files are in already
 * - unknown: blocked for a reason Download Check doesn't know
 * - unmapped: right title, but which file is which episode can't be told
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
 * - reject: out of the queue and the client, never grabbed again, and
 *   searched for again while anything it was for is still missing
 * - drop: out of the queue and the client, nothing else (a better copy is
 *   coming)
 * - clear: out of the queue, left in the client (it's been imported, or
 *   all of it that could be), and what's still missing searched for
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
 * A download Download Check found something wrong with, and what it did.
 * One row a download and stage: a download is judged once before it comes
 * down and once if its import gets stuck.
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

  /** The release's name. */
  @Column({ type: 'varchar' })
  public title: string;

  /** Sonarr's series or Radarr's movie. */
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

  /** What showing the finding needs (files, hours, qualities), as JSON. */
  @Column({ type: 'text', default: '{}' })
  public params: string;

  /** The server's own words for a blocked import. */
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
