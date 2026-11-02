import type { MediaServerKind } from '@server/constants/server';
import type { AccessSet } from '@server/interfaces/api/libraryAccessInterfaces';
import { resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** One person a change touched: what they had, and what they were given. */
export interface LibraryAccessEntry {
  /** Their id on the server. */
  id: string;
  name: string;
  before: AccessSet;
  after: AccessSet;
  /** Why the server refused it; the rest went through. */
  error?: string;
}

/**
 * One change to who sees which library on a media server, made from
 * Seerr AI: for its history and Undo.
 */
@Entity()
export class LibraryAccessChange {
  @PrimaryGeneratedColumn()
  public id: number;

  @Index()
  @Column({ type: 'varchar' })
  public serverKind: MediaServerKind;

  /** remove or add for everyone, or person for one person's libraries. */
  @Column({ type: 'varchar' })
  public action: 'remove' | 'add' | 'person';

  @Column({ type: 'varchar', nullable: true })
  public libraryId: string | null;

  @Column({ type: 'varchar', nullable: true })
  public libraryTitle: string | null;

  /** The admin who made it. */
  @Column({ type: 'integer', nullable: true })
  public userId: number | null;

  @Column({ type: 'simple-json' })
  public entries: LibraryAccessEntry[];

  @Column({ type: resolveDbType('datetime'), nullable: true })
  public undoneAt: Date | null;

  @CreateDateColumn({ type: resolveDbType('datetime') })
  public createdAt: Date;

  constructor(init?: Partial<LibraryAccessChange>) {
    Object.assign(this, init);
  }
}

export default LibraryAccessChange;
