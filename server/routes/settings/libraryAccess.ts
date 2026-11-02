import { ApiErrorCode } from '@server/constants/error';
import { MEDIA_SERVER_KINDS } from '@server/constants/server';
import libraryAccess, { LibraryAccessError } from '@server/lib/libraryAccess';
import logger from '@server/logger';
import type { NextFunction } from 'express';
import { Router } from 'express';
import { z } from 'zod';

/*
 * Who sees which library on each connected media server: one person's
 * libraries, and one library taken from (or given to) everyone at once,
 * with a preview first and Undo after. Admins only, as all of /settings.
 */
const libraryAccessRoutes = Router();

const kind = z.enum(MEDIA_SERVER_KINDS);

const bulkBody = z.object({
  libraryId: z.string().min(1),
  action: z.enum(['remove', 'add']),
});

const personBody = z.object({
  kind,
  all: z.boolean().optional(),
  libraries: z.array(z.string().min(1)).max(500),
});

/** Passes a refused change on with its status, anything else as a 500. */
const failed = (next: NextFunction, e: unknown) => {
  if (e instanceof LibraryAccessError) {
    return next({ status: e.status, message: e.message });
  }
  logger.error('Something went wrong with library access', {
    label: 'Library Access',
    errorMessage: e instanceof Error ? e.message : String(e),
  });
  return next({ status: 500, message: ApiErrorCode.Unknown });
};

libraryAccessRoutes.get('/history', async (req, res, next) => {
  const parsed = kind.optional().safeParse(req.query.kind || undefined);
  if (!parsed.success) {
    return next({ status: 400, message: 'Unknown media server.' });
  }
  try {
    return res.status(200).json(await libraryAccess.history(parsed.data));
  } catch (e) {
    return failed(next, e);
  }
});

libraryAccessRoutes.post('/history/:id/undo', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return next({ status: 400, message: 'Unknown change.' });
  }
  try {
    return res.status(200).json(await libraryAccess.undo(id));
  } catch (e) {
    return failed(next, e);
  }
});

libraryAccessRoutes.get('/user/:userId', async (req, res, next) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId) || userId < 1) {
    return next({ status: 400, message: 'Unknown user.' });
  }
  try {
    return res.status(200).json(await libraryAccess.forUser(userId));
  } catch (e) {
    return failed(next, e);
  }
});

libraryAccessRoutes.put('/user/:userId', async (req, res, next) => {
  const userId = Number(req.params.userId);
  const parsed = personBody.safeParse(req.body ?? {});
  if (!Number.isInteger(userId) || userId < 1 || !parsed.success) {
    return next({ status: 400, message: 'Choose the libraries to share.' });
  }
  try {
    const accounts = await libraryAccess.forUser(userId);
    const account = accounts.find((a) => a.kind === parsed.data.kind);
    if (!account?.person) {
      return next({
        status: 404,
        message: 'That server is not shared with them.',
      });
    }
    return res
      .status(200)
      .json(
        await libraryAccess.setPerson(
          parsed.data.kind,
          account.person.id,
          { all: !!parsed.data.all, libraries: parsed.data.libraries },
          req.user?.id ?? 0
        )
      );
  } catch (e) {
    return failed(next, e);
  }
});

libraryAccessRoutes.get('/:kind', async (req, res, next) => {
  const parsed = kind.safeParse(req.params.kind);
  if (!parsed.success) {
    return next({ status: 404, message: 'Unknown media server.' });
  }
  try {
    return res.status(200).json(await libraryAccess.view(parsed.data));
  } catch (e) {
    return failed(next, e);
  }
});

libraryAccessRoutes.post('/:kind/plan', async (req, res, next) => {
  const server = kind.safeParse(req.params.kind);
  const body = bulkBody.safeParse(req.body ?? {});
  if (!server.success || !body.success) {
    return next({ status: 400, message: 'Choose a library and what to do.' });
  }
  try {
    return res
      .status(200)
      .json(
        await libraryAccess.plan(
          server.data,
          body.data.libraryId,
          body.data.action
        )
      );
  } catch (e) {
    return failed(next, e);
  }
});

libraryAccessRoutes.post('/:kind/apply', async (req, res, next) => {
  const server = kind.safeParse(req.params.kind);
  const body = bulkBody.safeParse(req.body ?? {});
  if (!server.success || !body.success) {
    return next({ status: 400, message: 'Choose a library and what to do.' });
  }
  try {
    return res
      .status(200)
      .json(
        await libraryAccess.apply(
          server.data,
          body.data.libraryId,
          body.data.action,
          req.user?.id ?? 0
        )
      );
  } catch (e) {
    return failed(next, e);
  }
});

export default libraryAccessRoutes;
