import { resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { MediaRequest } from './MediaRequest';

/**
 * A Discord bot message with Approve and Decline buttons for a request
 * waiting for approval (lib/notifications/discordBot), kept so the buttons can
 * be taken away when the request is approved or declined somewhere else. Gone
 * once that has happened, or with the request.
 */
@Entity()
export class DiscordApprovalMessage {
  @PrimaryGeneratedColumn()
  public id: number;

  @ManyToOne(() => MediaRequest, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'requestId' })
  @Index()
  public request: MediaRequest;

  @Column()
  public requestId: number;

  @Column({ type: 'varchar' })
  public channelId: string;

  @Column({ type: 'varchar' })
  public messageId: string;

  @CreateDateColumn({ type: resolveDbType('datetime') })
  public createdAt: Date;

  constructor(init?: Partial<DiscordApprovalMessage>) {
    Object.assign(this, init);
  }
}

export default DiscordApprovalMessage;
