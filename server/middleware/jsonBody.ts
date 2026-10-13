import { checkUser } from '@server/middleware/auth';
import type { NextFunction, Request, Response } from 'express';
import express from 'express';

/*
 * Request bodies are JSON with the usual small limit, except a photo sent to
 * AI Search, which may be up to 8 MB. That larger limit is only for someone
 * signed in: reading 8 MB from anyone who asks, before knowing who they are,
 * would let anyone tie the server up.
 */

const AI_CHAT_PATH = '/api/v1/ai/chat';

const json = express.json();
const photoJson = express.json({ limit: '8mb' });

// Matched as Express matches routes: any case, with or without a final slash.
const isAiChat = (req: Request) =>
  req.path.toLowerCase().replace(/\/+$/, '') === AI_CHAT_PATH;

/** Every JSON body but AI Search's, read with the usual limit. */
export const jsonBody = (req: Request, res: Response, next: NextFunction) =>
  isAiChat(req) ? next() : json(req, res, next);

/**
 * AI Search's body, once the session is known: up to 8 MB for someone
 * signed in (the route checks the photo's size and type), the usual limit
 * for anyone else, whom the route turns away.
 */
export const aiChatBody = (req: Request, res: Response, next: NextFunction) => {
  if (!isAiChat(req)) return next();
  Promise.resolve(
    checkUser(req, res, () => (req.user ? photoJson : json)(req, res, next))
  ).catch(next);
};
