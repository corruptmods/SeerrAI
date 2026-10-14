import {
  MediaRequestStatus,
  MediaStatus,
  type VideoMediaType,
} from '@server/constants/media';
import dataSource from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import type { BlocklistItem } from '@server/interfaces/api/blocklistInterfaces';
import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import type { DataSource, EntityManager } from 'typeorm';
import {
  Column,
  Entity,
  In,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import type { ZodNumber, ZodOptional, ZodString } from 'zod';

@Entity()
@Unique(['tmdbId', 'mediaType'])
export class Blocklist implements BlocklistItem {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'varchar' })
  public mediaType: VideoMediaType;

  @Column({ nullable: true, type: 'varchar' })
  title?: string;

  @Column()
  @Index()
  public tmdbId: number;

  @ManyToOne(() => User, (user) => user.id, {
    eager: true,
  })
  @Index()
  user?: User;

  @OneToOne(() => Media, (media) => media.blocklist, {
    onDelete: 'CASCADE',
  })
  @JoinColumn()
  public media: Media;

  @Column({ nullable: true, type: 'varchar' })
  public blocklistedTags?: string;

  /** Why it was blocklisted, in the words of whoever did it. Optional. */
  @Column({ nullable: true, type: 'varchar' })
  public reason?: string | null;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  constructor(init?: Partial<Blocklist>) {
    Object.assign(this, init);
  }

  /**
   * Declines every request for a title that is still pending or approved,
   * now it is blocklisted and can no longer be fulfilled. Left as they were,
   * one could still be approved and sent to Radarr or Sonarr.
   *
   * A plain update, so nobody is sent a "declined" notification for what was
   * an admin's decision about the title, and no request hooks run. Returns
   * how many were declined.
   */
  public static async declineOpenRequests(
    mediaId: number,
    entityManager?: EntityManager | DataSource
  ): Promise<number> {
    const result = await (entityManager ?? dataSource)
      .createQueryBuilder()
      .update(MediaRequest)
      .set({ status: MediaRequestStatus.DECLINED })
      .where({
        media: { id: mediaId },
        status: In([MediaRequestStatus.PENDING, MediaRequestStatus.APPROVED]),
      })
      .execute();

    return result.affected ?? 0;
  }

  public static async addToBlocklist(
    {
      blocklistRequest,
    }: {
      blocklistRequest: {
        mediaType: VideoMediaType;
        title?: ZodOptional<ZodString>['_output'];
        tmdbId: ZodNumber['_output'];
        blocklistedTags?: string;
        reason?: string;
      };
    },
    entityManager?: EntityManager
  ): Promise<number> {
    const em = entityManager ?? dataSource;
    const blocklist = new this({
      ...blocklistRequest,
    });

    const mediaRepository = em.getRepository(Media);
    let media = await mediaRepository.findOne({
      where: {
        tmdbId: blocklistRequest.tmdbId,
        mediaType: blocklistRequest.mediaType,
      },
    });

    const blocklistRepository = em.getRepository(this);

    await blocklistRepository.save(blocklist);

    if (!media) {
      media = new Media({
        tmdbId: blocklistRequest.tmdbId,
        status: MediaStatus.BLOCKLISTED,
        status4k: MediaStatus.BLOCKLISTED,
        mediaType: blocklistRequest.mediaType,
        blocklist: Promise.resolve(blocklist),
      });

      await mediaRepository.save(media);
    } else {
      media.blocklist = Promise.resolve(blocklist);
      media.status = MediaStatus.BLOCKLISTED;
      media.status4k = MediaStatus.BLOCKLISTED;

      await mediaRepository.save(media);
    }

    return this.declineOpenRequests(media.id, em);
  }
}
