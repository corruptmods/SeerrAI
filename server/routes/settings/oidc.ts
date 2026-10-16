import type { OidcProblem } from '@server/constants/oidc';
import {
  DEFAULT_OIDC_SCOPES,
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
 * Settings → Users → Single Sign-On: the providers people can sign in with.
 * Like the download clients, the client secret is never sent back, a blank
 * one on saving or testing keeps the saved one (only while the issuer URL
 * is the same), and a provider is checked before it is saved.
 */
const oidcSettingsRoutes = Router();

/**
 * Says what is wrong: as a code with its details, which the settings page
 * shows in the admin's language, and in English for anything else.
 */
const refuse = (res: Response, problem: OidcProblem) =>
  res.status(400).json({ message: problemText(problem), ...problem });

const providerBody = z.object({
  name: z.string().trim().min(1).max(60),
  issuerUrl: z.string().trim().min(1),
  clientId: z.string().trim().min(1),
  clientSecret: z.string().default(''),
  logoUrl: z.string().trim().default(''),
  scopes: z.string().trim().default(DEFAULT_OIDC_SCOPES),
  enabled: z.boolean().default(true),
  newUserSignUp: z.boolean().default(false),
  // A list of rules, or upstream's claim names separated by spaces.
  requiredClaims: z
    .union([
      z.string(),
      z.array(z.object({ claim: z.string(), value: z.string().optional() })),
    ])
    .default([]),
});

const testBody = z.object({
  id: z.string().optional(),
  issuerUrl: z.string().trim().min(1),
  clientId: z.string().trim().min(1),
  clientSecret: z.string().default(''),
});

/** As the settings page is shown it: no secret, only that one is saved. */
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
 * A secret's address, for keeping a saved secret left blank: the saved one
 * only ever goes to the issuer it was saved for.
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
 * A logo: blank, an https address, or a picture on this site. Not plain
 * http: the sign-in page would show it over https without it.
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
    // Not an address at all.
  }
  return { problem: 'logo-url' };
};

/** Ids that must not be given again: current providers and removed ones. */
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

/**
 * Checks a provider can be used: its issuer URL is acceptable, a secret is
 * there, and the provider answers. Gives what the provider calls itself, or
 * what is wrong in plain words.
 */
const check = async (
  target: Pick<OidcProviderSettings, 'issuerUrl' | 'clientId' | 'clientSecret'>
): Promise<{ issuer: string } | OidcProblem> => {
  const problem = issuerUrlProblem(target.issuerUrl);
  if (problem) {
    return problem;
  }
  if (!target.clientSecret) {
    return { problem: 'client-secret' };
  }
  try {
    const config = await discover(target, { fresh: true });
    return { issuer: config.serverMetadata().issuer };
  } catch (e) {
    const found = discoveryProblem(e, target.issuerUrl);
    logger.warn('Single sign-on provider check failed', {
      label: 'Settings',
      issuerUrl: target.issuerUrl,
      problem: problemText(found),
    });
    return found;
  }
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

/** The provider as it will be saved, once it has passed the check. */
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
  return 'problem' in result ? result : provider;
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
  // The id stays: people's links refer to it.
  const provider = await toSave(parsed.data, saved.id, saved);
  if ('problem' in provider) {
    return refuse(res, provider);
  }

  // Links made at the old issuer stay with it: the provider at the new
  // address is someone else, whose ids for people mean nothing here. Each
  // person links again.
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
  // People's links to it stay, unused: its id is never given again.
  settings.oidc = {
    providers: settings.oidc.providers.filter((p) => p.id !== saved.id),
  };
  await settings.save();
  forgetDiscovery();
  return res.status(200).json(shown(saved));
});

export default oidcSettingsRoutes;
