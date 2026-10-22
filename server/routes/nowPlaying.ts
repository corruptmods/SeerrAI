import { MediaType } from '@server/constants/media';
import type { User } from '@server/entity/User';
import { featureEnabled } from '@server/lib/features';
import siri, { MOST_CHARACTERS, SiriError } from '@server/lib/siri';
import logger from '@server/logger';
import type { NextFunction, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';

/*
 * What Siri's "Fix this show" and "Fix this movie" shortcuts call: what is
 * playing for the person, their report of what's wrong with it, and their
 * yes or no when a fix would replace files. Every answer has `say`, the
 * sentence Siri speaks, refusals included. A Siri key works here and
 * nowhere else.
 */
const nowPlayingRoutes = Router();

const kindOf = (value: unknown) =>
  value === 'movie'
    ? MediaType.MOVIE
    : value === 'tv'
      ? MediaType.TV
      : undefined;

const refuse = (res: Response, status: number, message: string) =>
  res.status(status).json({ status, message, say: message });

const failed = (res: Response, next: NextFunction, e: unknown) => {
  if (e instanceof SiriError) return refuse(res, e.status, e.message);
  logger.error('A Siri report failed', {
    label: 'Siri',
    errorMessage: e instanceof Error ? e.message : String(e),
  });
  return refuse(res, 500, 'Something went wrong. Try again in a moment.');
};

nowPlayingRoutes.use((req, res, next) => {
  if (!featureEnabled('siri', req.user as User)) {
    return refuse(res, 403, 'Reporting with Siri is turned off.');
  }
  next();
});

nowPlayingRoutes.get('/', async (req, res, next) => {
  try {
    const answer = await siri.playing(req.user as User, kindOf(req.query.kind));
    return res.status(200).json(answer);
  } catch (e) {
    return failed(res, next, e);
  }
});

const report = z.object({
  problem: z.string().max(MOST_CHARACTERS * 2),
  item: z.string().max(40).optional(),
  kind: z.enum(['movie', 'tv']).optional(),
});

nowPlayingRoutes.post('/report', async (req, res, next) => {
  const parsed = report.safeParse(req.body);
  if (!parsed.success) {
    return refuse(res, 400, 'Say what’s wrong with it.');
  }
  try {
    const answer = await siri.report(req.user as User, {
      problem: parsed.data.problem,
      item: parsed.data.item || undefined,
      kind: kindOf(parsed.data.kind),
    });
    return res.status(200).json(answer);
  } catch (e) {
    return failed(res, next, e);
  }
});

const answer = z.object({
  confirm: z.string().min(1).max(64),
  answer: z
    .string()
    .transform((s) => s.trim().toLowerCase())
    .pipe(z.enum(['yes', 'no'])),
});

nowPlayingRoutes.post('/answer', async (req, res, next) => {
  const parsed = answer.safeParse(req.body);
  if (!parsed.success) {
    return refuse(res, 400, 'Answer yes or no.');
  }
  try {
    const done = await siri.answer(
      req.user as User,
      parsed.data.confirm,
      parsed.data.answer === 'yes'
    );
    return res.status(200).json(done);
  } catch (e) {
    return failed(res, next, e);
  }
});

export default nowPlayingRoutes;
