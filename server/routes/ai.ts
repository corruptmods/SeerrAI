import type { AiFeature } from '@server/constants/features';
import { AI_FEATURES } from '@server/constants/features';
import { AiError, aiFeatureOn, remainingToday } from '@server/lib/ai';
import {
  chat,
  explainLog,
  pickForRoom,
  pickablePeople,
  recap,
  recapPosition,
  reviewDeletions,
  suggestionReasons,
  triageIssue,
} from '@server/lib/ai/features';
import type { CompletionImage } from '@server/lib/ai/providers';
import { AiProviderError, IMAGE_TYPES } from '@server/lib/ai/providers';
import { Permission } from '@server/lib/permissions';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';

/*
 * The AI features. Every route checks its own switch (off for everyone, or
 * by this person, or AI not set up) and the daily limit, through lib/ai.
 */
const aiRoutes = Router();

/** An answer, or the reason there is none, as a message the page can show. */
const handle =
  (run: (req: Request) => Promise<unknown>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      return res.status(200).json(await run(req));
    } catch (e) {
      if (e instanceof AiError || e instanceof AiProviderError) {
        return next({ status: e.status, message: e.message });
      }
      if (e instanceof z.ZodError) {
        return next({ status: 400, message: e.issues[0]?.message });
      }
      logger.error('AI feature failed', {
        label: 'AI',
        path: req.path,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      return next({ status: 500, message: 'Something went wrong.' });
    }
  };

/**
 * Checked before any work: someone with the feature off, or a server with
 * no model, gets a plain refusal rather than lookups made for nothing.
 */
const need =
  (feature: AiFeature) => (req: Request, _res: Response, next: NextFunction) =>
    aiFeatureOn(feature, req.user)
      ? next()
      : next({ status: 403, message: 'This AI feature is turned off.' });

/** Which AI features this person has, and how many answers are left today. */
aiRoutes.get(
  '/status',
  handle(async (req) => ({
    features: Object.fromEntries(
      AI_FEATURES.map((feature) => [feature, aiFeatureOn(feature, req.user)])
    ),
    remaining: req.user ? await remainingToday(req.user) : 0,
  }))
);

/** Larger than any phone photo the app sends, which it shrinks first. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** How each picture type starts, so a file is what it says it is. */
const SIGNATURES: Record<CompletionImage['type'], (b: Buffer) => boolean> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) =>
    b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  'image/webp': (b) =>
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP',
  'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
};

const chatImage = z
  .object({
    type: z.enum(IMAGE_TYPES),
    data: z
      .string()
      .max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4, 'That picture is too big.')
      .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'That picture could not be read.'),
  })
  .refine(
    ({ type, data }) =>
      SIGNATURES[type](Buffer.from(data.slice(0, 32), 'base64')),
    'That picture could not be read.'
  );

const chatBody = z.object({
  message: z.string().trim().max(500).default(''),
  image: chatImage.optional(),
  turns: z
    .array(
      z.object({
        ask: z.string().max(500),
        reply: z
          .string()
          .optional()
          .transform((r) => r?.slice(0, 400)),
        offered: z.array(z.string().max(200)).max(10),
      })
    )
    .max(10)
    .default([]),
});

aiRoutes.post(
  '/chat',
  need('aiChat'),
  handle(async (req) => {
    const { message, turns, image } = chatBody.parse(req.body);
    if (!message && !image) {
      throw new AiError('Ask something, or send a picture.', 400);
    }
    return chat(req.user!, message, turns, image);
  })
);

aiRoutes.get(
  '/reasons',
  need('aiReasons'),
  handle(async (req) =>
    suggestionReasons(
      req.user!,
      Math.max(1, Number(req.query.page) || 1),
      req.query.mediaType === 'movie' || req.query.mediaType === 'tv'
        ? req.query.mediaType
        : undefined
    )
  )
);

aiRoutes.get(
  '/pick/people',
  need('aiPicker'),
  handle(async (req) => pickablePeople(req.user!))
);

const pickBody = z.object({
  people: z.array(z.number().int().positive()).max(6).default([]),
  kind: z.enum(['movie', 'tv', 'any']).default('any'),
  mood: z.string().trim().max(150).optional(),
  availableOnly: z.boolean().default(true),
});

aiRoutes.post(
  '/pick',
  need('aiPicker'),
  handle(async (req) => pickForRoom(req.user!, pickBody.parse(req.body)))
);

aiRoutes.get<{ tvId: string }>(
  '/recap/:tvId/position',
  need('aiRecap'),
  handle(async (req) => ({
    position: await recapPosition(req.user!, Number(req.params.tvId)),
  }))
);

const recapQuery = z.object({
  season: z.coerce.number().int().min(1).max(200),
  episode: z.coerce.number().int().min(1).max(2000),
});

aiRoutes.get<{ tvId: string }>(
  '/recap/:tvId',
  need('aiRecap'),
  handle(async (req) =>
    recap(req.user!, Number(req.params.tvId), recapQuery.parse(req.query))
  )
);

aiRoutes.post(
  '/deletion-review',
  isAuthenticated([Permission.MANAGE_REQUESTS, Permission.ADMIN], {
    type: 'or',
  }),
  need('aiDeletionReview'),
  handle(async (req) => reviewDeletions(req.user!))
);

aiRoutes.get<{ issueId: string }>(
  '/issue/:issueId',
  isAuthenticated([Permission.MANAGE_ISSUES, Permission.ADMIN], {
    type: 'or',
  }),
  need('aiIssueTriage'),
  handle(async (req) => triageIssue(req.user!, Number(req.params.issueId)))
);

const logBody = z.object({
  label: z.string().max(100).optional(),
  level: z.string().max(20).optional(),
  // Long entries are trimmed, not refused; only the start is sent anyway.
  message: z
    .string()
    .min(1)
    .transform((m) => m.slice(0, 2000)),
  data: z.unknown().optional(),
});

aiRoutes.post(
  '/explain-log',
  isAuthenticated(Permission.ADMIN),
  need('aiLogs'),
  handle(async (req) => explainLog(req.user!, logBody.parse(req.body)))
);

export default aiRoutes;
