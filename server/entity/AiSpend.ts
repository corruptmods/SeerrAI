import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * What Seerr's own AI requests used, per model per day: the tokens the
 * provider bills for, to estimate spending without an admin key.
 */
@Entity()
@Unique(['day', 'model'])
export class AiSpend {
  @PrimaryGeneratedColumn()
  public id: number;

  /** YYYY-MM-DD in the server's time zone. */
  @Column({ type: 'varchar', length: 10 })
  public day: string;

  @Column({ type: 'varchar', length: 200 })
  public model: string;

  @Column({ default: 0 })
  public requests: number;

  @Column({ default: 0 })
  public inputTokens: number;

  /** Thinking included: it is billed as output. */
  @Column({ default: 0 })
  public outputTokens: number;

  constructor(init?: Partial<AiSpend>) {
    Object.assign(this, init);
  }
}

export default AiSpend;
