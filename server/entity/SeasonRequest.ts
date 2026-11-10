import { MediaRequestStatus } from '@server/constants/media';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import EpisodeRequest from './EpisodeRequest';
import { MediaRequest } from './MediaRequest';

@Entity()
class SeasonRequest {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column()
  public seasonNumber: number;

  @Column({ type: 'int', default: MediaRequestStatus.PENDING })
  public status: MediaRequestStatus;

  /**
   * Sent before Sonarr listed this season (announced, not yet on TheTVDB).
   * The Sonarr scan keeps it coming and monitors it once Sonarr lists it.
   */
  @Column({ default: false })
  public awaitingSonarr: boolean;

  @ManyToOne(() => MediaRequest, (request) => request.seasons, {
    onDelete: 'CASCADE',
  })
  @Index()
  public request: MediaRequest;

  @OneToMany(
    () => EpisodeRequest,
    (episodeRequest: EpisodeRequest) => episodeRequest.seasonRequest,
    { cascade: true, eager: true }
  )
  public episodes: EpisodeRequest[];

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<SeasonRequest>) {
    Object.assign(this, init);
  }
}

export default SeasonRequest;
