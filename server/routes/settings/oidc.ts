import type { OidcProblem } from '@server/constants/oidc';
import {
  DEFAULT_OIDC_SCOPES,
  issuerFromEntered,
  normalizeIssuer,
  oidcApplicationUrl,
  oidcCallbackUrl,
  oidcProviderId,
  requiredClaimsFrom,
} from '@server/constants/oidc';
import { getRepository } from '@server/datasource';
import OidcLink from '@server/entity/OidcLink';
import {
  discover,
  discoveryProblem,
  forgetDiscovery,
  issuerUrlProblem,
  keepLinksAtIssuer,
  normalizeScopes,
  problemText,
} from '@server/lib/oidc';
import { keptSecret } from '@server/lib/savedSecret';
import type { OidcProviderSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';

/*
 * Settings → Users → Single Sign-On providers. As for download clients: the
 * client secret is never sent back, a blank one keeps the saved one (only
 * for the same issuer URL), and a provider is checked before saving.
 */
const oidcSettingsRoutes = Router();

/**
 * Answers 400 with the problem code and details (translated by the settings
 * page) plus an English message.
 */
const refuse = (res: Response, problem: OidcProblem) =>
  res.status(400).json({ message: problemText(problem), ...problem });

/** The issuer URL, or a pasted configuration URL. */
const issuerUrl = z.string().trim().min(1).transform(issuerFromEntered);

const providerBody = z.object({
  name: z.string().trim().min(1).max(60),
  issuerUrl,
  clientId: z.string().trim().min(1),
  clientSecret: z.string().default(''),
  logoUrl: z.string().trim().default(''),
  scopes: z.string().trim().default(DEFAULT_OIDC_SCOPES),
  enabled: z.boolean().default(true),
  newUserSignUp: z.boolean().default(false),
  // A list of rules, or upstream's space-separated claim names.
  requiredClaims: z
    .union([
      z.string(),
      z.array(z.object({ claim: z.string(), value: z.string().optional() })),
    ])
    .default([]),
});

const testBody = z.object({
  id: z.string().optional(),
  issuerUrl,
  clientId: z.string().trim().min(1),
  clientSecret: z.string().default(''),
});

/** Provider as shown to the page: no secret, only whether one is saved. */
const shown = (provider: OidcProviderSettings) => {
  const applicationUrl = oidcApplicationUrl(getSettings().main.applicationUrl);
  return {
    ...provider,
    clientSecret: '',
    hasClientSecret: !!provider.clientSecret,
    callbackUrl: applicationUrl
      ? oidcCallbackUrl(applicationUrl, provider.id)
      : null,
  };
};

/**
 * Address a saved secret is bound to: a blank secret keeps the saved one only
 * for the issuer it was saved for.
 */
const addressOf = (issuerUrl: string) => {
  try {
    const url = new URL(issuerUrl);
    return {
      hostname: url.hostname,
      port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
      useSsl: url.protocol === 'https:',
      urlBase: url.pathname,
    };
  } catch {
    return { hostname: issuerUrl };
  }
};

const secretFor = (
  entered: string,
  issuerUrl: string,
  saved?: OidcProviderSettings
) =>
  keptSecret(
    entered,
    addressOf(issuerUrl),
    saved && addressOf(saved.issuerUrl),
    saved?.clientSecret
  );

/**
 * A logo must be blank, https, or a path on this site. Plain http is refused:
 * it would be mixed content on an https sign-in page.
 */
const logoProblem = (logoUrl: string): OidcProblem | undefined => {
  if (!logoUrl || /^\/(?![/\\])/.test(logoUrl)) {
    return undefined;
  }
  try {
    const url = new URL(logoUrl);
    if (url.protocol === 'https:') {
      return undefined;
    }
  } catch {
    // Not a URL.
  }
  return { problem: 'logo-url' };
};

/** Ids never to reuse: current and removed providers'. */
const takenIds = async (): Promise<string[]> => {
  const linked = await getRepository(OidcLink)
    .createQueryBuilder('link')
    .select('DISTINCT link.provider', 'provider')
    .getRawMany<{ provider: string }>();
  return [
    ...new Set([
      ...getSettings().oidc.providers.map((provider) => provider.id),
      ...linked.map((row) => row.provider),
    ]),
  ];
};

type CheckTarget = Pick<
  OidcProviderSettings,
  'issuerUrl' | 'clientId' | 'clientSecret'
>;

/** The provider's own issuer, fetched fresh. */
const issuerOf = async (target: CheckTarget): Promise<string> =>
  (await discover(target, { fresh: true })).serverMetadata().issuer;

/**
 * Checks a provider is usable: acceptable issuer URL, a secret, and the
 * provider answers. Returns its issuer and the issuer URL to keep, or the
 * problem.
 *
 * An issuer URL differing from the provider's only by a trailing slash is
 * accepted: links already treat them as one, and an admin pasting the
 * configuration URL can't tell which the provider uses (Authentik's has one,
 * Keycloak's doesn't).
 */
const check = async (
  target: CheckTarget
): Promise<{ issuer: string; issuerUrl: string } | OidcProblem> => {
  const problem = issuerUrlProblem(target.issuerUrl);
  if (problem) {
    return problem;
  }
  if (!target.clientSecret) {
    return { problem: 'client-secret' };
  }
  let found: OidcProblem;
  try {
    return { issuer: await issuerOf(target), issuerUrl: target.issuerUrl };
  } catch (e) {
    found = discoveryProblem(e, target.issuerUrl);
  }
  const said =
    found.problem === 'issuer-mismatch' ? found.params?.issuer : undefined;
  if (
    typeof said === 'string' &&
    said !== target.issuerUrl &&
    normalizeIssuer(said) === normalizeIssuer(target.issuerUrl)
  ) {
    try {
      const own = { ...target, issuerUrl: said };
      return { issuer: await issuerOf(own), issuerUrl: said };
    } catch (e) {
      found = discoveryProblem(e, said);
    }
  }
  logger.warn('Single sign-on provider check failed', {
    label: 'Settings',
    issuerUrl: target.issuerUrl,
    problem: problemText(found),
  });
  return found;
};

oidcSettingsRoutes.get('/', async (_req, res) => {
  res.status(200).json({
    applicationUrl: oidcApplicationUrl(getSettings().main.applicationUrl),
    providers: getSettings().oidc.providers.map(shown),
    takenIds: await takenIds(),
  });
});

oidcSettingsRoutes.post('/test', async (req, res) => {
  const parsed = testBody.safeParse(req.body);
  if (!parsed.success) {
    return refuse(res, { problem: 'check-details' });
  }
  const saved = getSettings().oidc.providers.find(
    (provider) => provider.id === parsed.data.id
  );
  const result = await check({
    issuerUrl: parsed.data.issuerUrl,
    clientId: parsed.data.clientId,
    clientSecret: secretFor(
      parsed.data.clientSecret,
      parsed.data.issuerUrl,
      saved
    ),
  });
  if ('problem' in result) {
    return refuse(res, result);
  }
  return res.status(200).json(result);
});

/** The provider to save, once it passes the check. */
const toSave = async (
  body: z.infer<typeof providerBody>,
  id: string,
  saved?: OidcProviderSettings
): Promise<OidcProviderSettings | OidcProblem> => {
  const logo = logoProblem(body.logoUrl);
  if (logo) {
    return logo;
  }
  if (
    Array.isArray(body.requiredClaims) &&
    body.requiredClaims.some(({ claim }) => !/^\S+$/.test(claim.trim()))
  ) {
    return { problem: 'claim-name' };
  }
  const provider: OidcProviderSettings = {
    id,
    name: body.name,
    issuerUrl: body.issuerUrl,
    clientId: body.clientId,
    clientSecret: secretFor(body.clientSecret, body.issuerUrl, saved),
    logoUrl: body.logoUrl,
    scopes: normalizeScopes(body.scopes),
    enabled: body.enabled,
    newUserSignUp: body.newUserSignUp,
    requiredClaims: requiredClaimsFrom(body.requiredClaims),
  };
  const result = await check(provider);
  return 'problem' in result
    ? result
    : { ...provider, issuerUrl: result.issuerUrl };
};

oidcSettingsRoutes.post('/', async (req, res) => {
  const parsed = providerBody.safeParse(req.body);
  if (!parsed.success) {
    return refuse(res, { problem: 'check-details' });
  }
  const id = oidcProviderId(parsed.data.name, await takenIds());
  const provider = await toSave(parsed.data, id);
  if ('problem' in provider) {
    return refuse(res, provider);
  }

  const settings = getSettings();
  settings.oidc = { providers: [...settings.oidc.providers, provider] };
  await settings.save();
  forgetDiscovery();
  return res.status(201).json(shown(provider));
});

oidcSettingsRoutes.put<{ id: string }>('/:id', async (req, res, next) => {
  const settings = getSettings();
  const saved = settings.oidc.providers.find((p) => p.id === req.params.id);
  if (!saved) {
    return next({ status: 404, message: 'Provider not found.' });
  }
  const parsed = providerBody.safeParse(req.body);
  if (!parsed.success) {
    return refuse(res, { problem: 'check-details' });
  }
  // Keep the id: users' links refer to it.
  const provider = await toSave(parsed.data, saved.id, saved);
  if ('problem' in provider) {
    return refuse(res, provider);
  }

  // Links stay with the old issuer: a new issuer's user ids mean nothing
  // here, so each user links again.
  if (
    normalizeIssuer(provider.issuerUrl) !== normalizeIssuer(saved.issuerUrl)
  ) {
    await keepLinksAtIssuer(saved.id, saved.issuerUrl);
  }
  settings.oidc = {
    providers: settings.oidc.providers.map((p) =>
      p.id === saved.id ? provider : p
    ),
  };
  await settings.save();
  forgetDiscovery();
  return res.status(200).json(shown(provider));
});

oidcSettingsRoutes.delete<{ id: string }>('/:id', async (req, res, next) => {
  const settings = getSettings();
  const saved = settings.oidc.providers.find((p) => p.id === req.params.id);
  if (!saved) {
    return next({ status: 404, message: 'Provider not found.' });
  }
  // Users' links to it stay, unused; its id is never reused.
  settings.oidc = {
    providers: settings.oidc.providers.filter((p) => p.id !== saved.id),
  };
  await settings.save();
  forgetDiscovery();
  return res.status(200).json(shown(saved));
});

export default oidcSettingsRoutes;
