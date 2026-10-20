/* eslint-disable @typescript-eslint/no-unused-vars */
import type { User } from '@server/entity/User';
import type { NextFunction, Request, Response } from 'express';
import 'express-session';

declare global {
  namespace Express {
    export interface Request {
      user?: User;
      locale?: string;
      /**
       * How `user` was found: a signed-in session, the server's API key, or
       * someone's personal API key (lib/personalApiKeys).
       */
      authMethod?: 'session' | 'apiKey' | 'personalKey';
    }
  }

  export type Middleware = <ParamsDictionary, any, any>(
    req: Request,
    res: Response,
    next: NextFunction
  ) => Promise<void | NextFunction> | void | NextFunction;
}
