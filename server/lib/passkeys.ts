import type UserPasskey from '@server/entity/UserPasskey';
import { getSettings } from '@server/lib/settings';
import type { Request } from 'express';

/*
 * What a passkey is bound to. A passkey belongs to one site name (the
 * "relying party"), and a browser only offers it on that site.
 *
 * When Seerr's Application URL is set, that address is the only one passkeys
 * work on: a passkey made there cannot be presented anywhere else, and no
 * other Host header is trusted. Without it, the address the browser used is
 * taken, which is how most setups without a configured URL are reached.
 */
export const relyingParty = (
  req: Request
): { rpID: string; origin: string | string[]; name: string } => {
  const { applicationUrl, applicationTitle } = getSettings().main;
  const name = applicationTitle || 'Seerr';

  if (applicationUrl) {
    try {
      const url = new URL(applicationUrl);
      return { rpID: url.hostname, origin: url.origin, name };
    } catch {
      // A malformed setting falls through to the address used.
    }
  }

  // Without an Application URL, the address the browser used. Behind an
  // HTTPS proxy that Seerr is not told to trust, the request arrives as plain
  // http, so accept either scheme for this exact host: browsers only offer
  // passkeys on secure pages, so the scheme adds nothing to check.
  const host = req.get('host') ?? req.hostname;
  return {
    rpID: req.hostname,
    origin: [`https://${host}`, `http://${host}`],
    name,
  };
};

/** What a passkey list shows: never the key itself. */
export const passkeySummary = (passkey: UserPasskey) => ({
  id: passkey.id,
  name: passkey.name,
  backedUp: passkey.backedUp,
  createdAt: passkey.createdAt,
  lastUsedAt: passkey.lastUsedAt ?? null,
});

/** How long a sign-in or setup has to finish once started. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type ChallengePurpose = 'register' | 'login';

interface ChallengeSession {
  passkeyChallenge?: {
    value: string;
    purpose: ChallengePurpose;
    issuedAt: number;
  };
}

export const rememberChallenge = (
  session: ChallengeSession,
  value: string,
  purpose: ChallengePurpose
) => {
  session.passkeyChallenge = { value, purpose, issuedAt: Date.now() };
};

/**
 * The challenge this browser was given, used once: a response can never be
 * replayed against it, and one issued for setup cannot finish a sign-in.
 */
export const takeChallenge = (
  session: ChallengeSession,
  purpose: ChallengePurpose,
  now = Date.now()
): string | undefined => {
  const challenge = session.passkeyChallenge;
  delete session.passkeyChallenge;

  if (
    !challenge ||
    challenge.purpose !== purpose ||
    now - challenge.issuedAt > CHALLENGE_TTL_MS
  ) {
    return undefined;
  }
  return challenge.value;
};

/*
 * Password managers identify themselves by AAGUID (from the community list at
 * github.com/passkeydeveloper/passkey-authenticator-aaguids). Where one is
 * known, the passkey is named after it ("Apple Passwords"), since it lives on
 * every device signed in to it; otherwise after the device it was made on.
 */
const PROVIDERS: Record<string, string> = {
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'Apple Passwords',
  'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'Apple Passwords',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome on Mac',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  '53414d53-554e-4700-0000-000000000000': 'Samsung Pass',
  '531126d6-e717-415c-9320-3d9aa6981239': 'Dashlane',
  'b84e4048-15dc-4dd0-8640-f4f60813c8af': 'NordPass',
  '50726f74-6f6e-5061-7373-50726f746f6e': 'Proton Pass',
  'd3452668-01fd-4c12-926c-83a4204853aa': 'Microsoft Password Manager',
  'f3809540-7f14-49c1-a8b3-8f813b225541': 'Enpass',
  'fdb141b2-5d84-443e-8a35-4698c205a502': 'KeePassXC',
  '0ea242b4-43c4-4a1b-8b17-dd6d0b6baec6': 'Keeper',
};

const DEVICES: [RegExp, string][] = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/CrOS/, 'Chromebook'],
  [/Macintosh|Mac OS X/, 'Mac'],
  [/Windows/, 'Windows'],
  [/Linux/, 'Linux'],
];

export const passkeyName = (
  aaguid: string | undefined,
  userAgent: string | undefined
): string => {
  const provider = aaguid ? PROVIDERS[aaguid.toLowerCase()] : undefined;
  if (provider) {
    return provider;
  }
  const device = DEVICES.find(([pattern]) => pattern.test(userAgent ?? ''));
  return device ? device[1] : 'Passkey';
};

/** Names are shown back in settings; kept short and single-line. */
export const cleanPasskeyName = (name: unknown): string | undefined => {
  if (typeof name !== 'string') {
    return undefined;
  }
  const cleaned = name.replace(/\s+/g, ' ').trim().slice(0, 64);
  return cleaned || undefined;
};
