import {
  Column,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import SeasonRequest from './SeasonRequest';

/**
 * A single episode covered by a season request.
 *
 * A season request with no episode rows means the whole season, which is the
 * pre-existing behaviour and what every migrated request represents.
 */
@Entity()
@Unique(['seasonRequest', 'episodeNumber'])
class EpisodeRequest {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column()
  public episodeNumber: number;

  @Index()
  @ManyToOne(
    () => SeasonRequest,
    (seasonRequest: SeasonRequest) => seasonRequest.episodes,
    { onDelete: 'CASCADE' }
  )
  public seasonRequest: SeasonRequest;

  constructor(init?: Partial<EpisodeRequest>) {
    Object.assign(this, init);
  }
}

export default EpisodeRequest;
