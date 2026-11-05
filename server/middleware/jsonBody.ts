import { checkUser } from '@server/middleware/auth';
import type { NextFunction, Request, Response } from 'express';
import express from 'express';

// JSON bodies use the usual small limit, except AI Search photos, up to 8 MB.
// The larger limit is only for signed-in users: reading 8 MB from anyone before
// knowing who they are would let anyone tie the server up.

const AI_CHAT_PATH = '/api/v1/ai/chat';

const json = express.json();
const photoJson = express.json({ limit: '8mb' });

// Matched as Express matches routes: any case, optional trailing slash.
const isAiChat = (req: Request) =>
  req.path.toLowerCase().replace(/\/+$/, '') === AI_CHAT_PATH;

/** Parses every JSON body except AI Search's, with the usual limit. */
export const jsonBody = (req: Request, res: Response, next: NextFunction) =>
  isAiChat(req) ? next() : json(req, res, next);

/**
 * AI Search's body, once the session is known: up to 8 MB for signed-in users
 * (the route checks the photo's size and type), the usual limit for anyone
 * else, whom the route rejects.
 */
export const aiChatBody = (req: Request, res: Response, next: NextFunction) => {
  if (!isAiChat(req)) return next();
  Promise.resolve(
    checkUser(req, res, () => (req.user ? photoJson : json)(req, res, next))
  ).catch(next);
};
