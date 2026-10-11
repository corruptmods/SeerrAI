import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * How many AI answers one person has had on one day, for the daily limit.
 * Only the last week is kept.
 */
@Entity()
@Unique(['userId', 'day'])
export class AiUsage {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column()
  public userId: number;

  /** YYYY-MM-DD in the server's time zone. */
  @Column({ type: 'varchar', length: 10 })
  public day: string;

  @Column({ default: 0 })
  public uses: number;

  constructor(init?: Partial<AiUsage>) {
    Object.assign(this, init);
  }
}

export default AiUsage;
