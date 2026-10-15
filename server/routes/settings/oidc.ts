import {
  DEFAULT_OIDC_SCOPES,
  oidcApplicationUrl,
  oidcCallbackUrl,
  oidcProviderId,
} from '@server/constants/oidc';
import { getRepository } from '@server/datasource';
import OidcLink from '@server/entity/OidcLink';
import {
  discover,
  discoveryProblem,
  forgetDiscovery,
  issuerUrlProblem,
  normalizeScopes,
} from '@server/lib/oidc';
import { keptSecret } from '@server/lib/savedSecret';
import type { OidcProviderSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { Router } from 'express';
import { z } from 'zod';

/*
 * Settings → Users → Single Sign-On: the providers people can sign in with.
 * Like the download clients, the client secret is never sent back, a blank
 * one on saving or testing keeps the saved one (only while the issuer URL
 * is the same), and a provider is checked before it is saved.
 */
const oidcSettingsRoutes = Router();

const providerBody = z.object({
  name: z.string().trim().min(1).max(60),
  issuerUrl: z.string().trim().min(1),
  clientId: z.string().trim().min(1),
  clientSecret: z.string().default(''),
  logoUrl: z.string().trim().default(''),
  scopes: z.string().trim().default(DEFAULT_OIDC_SCOPES),
  enabled: z.boolean().default(true),
  newUserSignUp: z.boolean().default(false),
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
const logoProblem = (logoUrl: string): string | undefined => {
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
  return 'The logo must be an address starting with https://, or left blank.';
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
): Promise<{ issuer: string } | { problem: string }> => {
  const problem = issuerUrlProblem(target.issuerUrl);
  if (problem) {
    return { problem };
  }
  if (!target.clientSecret) {
    return { problem: 'Enter the client secret.' };
  }
  try {
    const config = await discover(target, { fresh: true });
    return { issuer: config.serverMetadata().issuer };
  } catch (e) {
    const message = discoveryProblem(e, target.issuerUrl);
    logger.warn('Single sign-on provider check failed', {
      label: 'Settings',
      issuerUrl: target.issuerUrl,
      problem: message,
    });
    return { problem: message };
  }
};

oidcSettingsRoutes.get('/', async (_req, res) => {
  res.status(200).json({
    applicationUrl: oidcApplicationUrl(getSettings().main.applicationUrl),
    providers: getSettings().oidc.providers.map(shown),
    takenIds: await takenIds(),
  });
});

oidcSettingsRoutes.post('/test', async (req, res, next) => {
  const parsed = testBody.safeParse(req.body);
  if (!parsed.success) {
    return next({ status: 400, message: 'Check the provider details.' });
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
    return next({ status: 400, message: result.problem });
  }
  return res.status(200).json(result);
});

/** The provider as it will be saved, once it has passed the check. */
const toSave = async (
  body: z.infer<typeof providerBody>,
  id: string,
  saved?: OidcProviderSettings
): Promise<OidcProviderSettings | { problem: string }> => {
  const logo = logoProblem(body.logoUrl);
  if (logo) {
    return { problem: logo };
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
  };
  const result = await check(provider);
  return 'problem' in result ? result : provider;
};

oidcSettingsRoutes.post('/', async (req, res, next) => {
  const parsed = providerBody.safeParse(req.body);
  if (!parsed.success) {
    return next({ status: 400, message: 'Check the provider details.' });
  }
  const id = oidcProviderId(parsed.data.name, await takenIds());
  const provider = await toSave(parsed.data, id);
  if ('problem' in provider) {
    return next({ status: 400, message: provider.problem });
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
    return next({ status: 400, message: 'Check the provider details.' });
  }
  // The id stays: people's links refer to it.
  const provider = await toSave(parsed.data, saved.id, saved);
  if ('problem' in provider) {
    return next({ status: 400, message: provider.problem });
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
