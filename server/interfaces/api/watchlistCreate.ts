import { MediaType } from '@server/constants/media';
import { z } from 'zod';

export const watchlistCreate = z.object({
  ratingKey: z.coerce.string().optional(),
  tmdbId: z.coerce.number(),
  mediaType: z.enum([MediaType.MOVIE, MediaType.TV]),
  title: z.coerce.string().optional(),
});
