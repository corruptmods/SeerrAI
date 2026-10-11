import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { MediaRequest } from './MediaRequest';
import { User } from './User';

/**
 * A user other than the original requester who wants to be notified when a
 * request becomes available.
 *
 * Seerr rejects a second request for media that is already requested, which
 * leaves everyone except the first requester with no way to hear about it.
 */
@Entity()
@Unique(['request', 'user'])
export class MediaRequestWatcher {
  @PrimaryGeneratedColumn()
  public id: number;

  @ManyToOne(() => MediaRequest, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'requestId' })
  @Index()
  public request: MediaRequest;

  @Column()
  public requestId: number;

  @ManyToOne(() => User, { eager: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  @Index()
  public user: User;

  @Column()
  public userId: number;

  @CreateDateColumn()
  public createdAt: Date;

  constructor(init?: Partial<MediaRequestWatcher>) {
    Object.assign(this, init);
  }
}

export default MediaRequestWatcher;
