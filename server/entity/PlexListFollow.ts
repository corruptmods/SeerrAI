import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './User';

/**
 * One of a person's Plex lists with auto-request on: what's added to it on
 * Plex is requested for them (lib/plexLists). A row exists only while the
 * switch is on.
 */
@Entity()
@Unique(['userId', 'plexListId'])
export class PlexListFollow {
  @PrimaryGeneratedColumn()
  public id: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  @Index()
  public user: User;

  @Column()
  public userId: number;

  /** Plex's id for the list. */
  @Column({ type: 'varchar' })
  public plexListId: string;

  /** Its owner and slug on Plex, to read it. */
  @Column({ type: 'varchar' })
  public owner: string;

  @Column({ type: 'varchar' })
  public slug: string;

  /**
   * The Plex ids of the titles already dealt with: on the list when the
   * switch was turned on, or requested (or found here) since. A title taken
   * off the list leaves it, so adding it again requests it again.
   */
  @Column({ type: 'simple-json' })
  public handled: string[];

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public checkedAt?: Date | null;

  /** Why the last check failed, if it did. */
  @Column({ type: 'varchar', nullable: true })
  public problem?: string | null;

  @CreateDateColumn({ type: resolveDbType('datetime') })
  public createdAt: Date;

  @UpdateDateColumn({ type: resolveDbType('datetime') })
  public updatedAt: Date;

  constructor(init?: Partial<PlexListFollow>) {
    Object.assign(this, init);
  }
}

export default PlexListFollow;
