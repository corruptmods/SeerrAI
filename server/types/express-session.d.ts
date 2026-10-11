import 'express-session';

// Declaration merging to apply our own types to SessionData
// See: (https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/types/express-session/index.d.ts#L23)
declare module 'express-session' {
  interface SessionData {
    userId: number;
    /** A passkey setup or sign-in in progress; used once. */
    passkeyChallenge?: {
      value: string;
      purpose: 'register' | 'login';
      issuedAt: number;
    };
  }
}
