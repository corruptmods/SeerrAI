import JellyfinAPI from '@server/api/jellyfin';
import PlexTvAPI from '@server/api/plextv';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import UserPasskey from '@server/entity/UserPasskey';
import {
  cleanPasskeyName,
  passkeyName,
  passkeySummary,
  relyingParty,
  rememberChallenge,
  takeChallenge,
} from '@server/lib/passkeys';
import { getSettings } from '@server/lib/settings';
import { startSession } from '@server/lib/signIn';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { getHostname } from '@server/utils/getHostname';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { Router } from 'express';

/*
 * Signing in with a passkey instead of a Plex account. Anyone signed in can
 * add several (a phone, a computer, a security key), see them, rename them
 * and remove them. A passkey signs in the same person with the same
 * permissions; a Plex account still has to have access to the server.
 */

const passkeyRoutes = Router();

const toBase64Url = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString('base64url');
const fromBase64Url = (text: string) =>
  new Uint8Array(Buffer.from(text, 'base64url'));

/** Stable per person, and not their email: a device keeps one passkey each. */
const userHandle = (user: User) =>
  new Uint8Array(Buffer.from(`seerr-user-${user.id}`, 'utf8'));

passkeyRoutes.get('/', isAuthenticated(), async (req, res, next) => {
  try {
    const passkeys = await getRepository(UserPasskey).find({
      where: { user: { id: req.user?.id } },
      order: { createdAt: 'ASC' },
    });
    return res.status(200).json(passkeys.map(passkeySummary));
  } catch (e) {
    return next({ status: 500, message: e.message });
  }
});

passkeyRoutes.post(
  '/register/options',
  isAuthenticated(),
  async (req, res, next) => {
    try {
      const user = req.user as User;
      const { rpID, name } = relyingParty(req);
      const existing = await getRepository(UserPasskey).find({
        where: { user: { id: user.id } },
      });

      const options = await generateRegistrationOptions({
        rpName: name,
        rpID,
        userID: userHandle(user),
        userName: user.email || user.displayName,
        userDisplayName: user.displayName,
        attestationType: 'none',
        // A device that already has one is not offered a second.
        excludeCredentials: existing.map((passkey) => ({
          id: passkey.credentialId,
          transports: passkey.transports?.split(',').filter(Boolean),
        })),
        authenticatorSelection: {
          residentKey: 'required',
          userVerification: 'required',
        },
      });

      rememberChallenge(req.session, options.challenge, 'register');
      return res.status(200).json(options);
    } catch (e) {
      return next({ status: 500, message: e.message });
    }
  }
);

passkeyRoutes.post('/register', isAuthenticated(), async (req, res, next) => {
  const user = req.user as User;
  const body = req.body as {
    response?: RegistrationResponseJSON;
    name?: string;
  };
  const expectedChallenge = takeChallenge(req.session, 'register');

  if (!expectedChallenge || !body.response) {
    return next({
      status: 400,
      message: 'Passkey setup expired. Try again.',
    });
  }

  try {
    const { rpID, origin } = relyingParty(req);
    const verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });

    if (!verification.verified) {
      return next({ status: 400, message: 'Passkey could not be verified.' });
    }

    const info = verification.registrationInfo;
    const repository = getRepository(UserPasskey);

    if (
      await repository.exist({ where: { credentialId: info.credential.id } })
    ) {
      return next({ status: 409, message: 'This passkey is already added.' });
    }

    const passkey = await repository.save(
      new UserPasskey({
        user,
        credentialId: info.credential.id,
        publicKey: toBase64Url(info.credential.publicKey),
        counter: String(info.credential.counter),
        transports: info.credential.transports?.join(',') || null,
        backedUp: info.credentialBackedUp,
        name:
          cleanPasskeyName(body.name) ??
          passkeyName(info.aaguid, req.get('user-agent')),
      })
    );

    logger.info('Passkey added', {
      label: 'Auth',
      userId: user.id,
      passkeyId: passkey.id,
      name: passkey.name,
    });

    return res.status(201).json(passkeySummary(passkey));
  } catch (e) {
    logger.warn('Passkey setup failed', {
      label: 'Auth',
      userId: user.id,
      errorMessage: e.message,
    });
    return next({ status: 400, message: 'Passkey could not be verified.' });
  }
});

passkeyRoutes.put<{ id: string }>(
  '/:id',
  isAuthenticated(),
  async (req, res, next) => {
    const name = cleanPasskeyName((req.body as { name?: string }).name);
    if (!name) {
      return next({ status: 400, message: 'A name is required.' });
    }
    try {
      const repository = getRepository(UserPasskey);
      const passkey = await repository.findOne({
        where: { id: Number(req.params.id), user: { id: req.user?.id } },
      });
      if (!passkey) {
        return next({ status: 404, message: 'Passkey not found.' });
      }
      await repository.update(passkey.id, { name });
      return res
        .status(200)
        .json(passkeySummary({ ...passkey, name } as UserPasskey));
    } catch (e) {
      return next({ status: 500, message: e.message });
    }
  }
);

passkeyRoutes.delete<{ id: string }>(
  '/:id',
  isAuthenticated(),
  async (req, res, next) => {
    try {
      const result = await getRepository(UserPasskey).delete({
        id: Number(req.params.id),
        user: { id: req.user?.id },
      });
      if (!result.affected) {
        return next({ status: 404, message: 'Passkey not found.' });
      }
      logger.info('Passkey removed', {
        label: 'Auth',
        userId: req.user?.id,
        passkeyId: Number(req.params.id),
      });
      return res.status(204).send();
    } catch (e) {
      return next({ status: 500, message: e.message });
    }
  }
);

passkeyRoutes.post('/login/options', async (req, res, next) => {
  try {
    const { rpID } = relyingParty(req);
    // No list of credentials: the device offers whichever of its passkeys
    // belong to this site, so nobody has to type who they are first.
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
    });
    rememberChallenge(req.session, options.challenge, 'login');
    return res.status(200).json(options);
  } catch (e) {
    return next({ status: 500, message: e.message });
  }
});

/**
 * Whether this person may still sign in. The same rules as signing in with
 * the media server or a password: a Plex account the server owner has
 * stopped sharing with is refused, so is a Jellyfin or Emby account that
 * has been deleted or switched off there, and so is a way of signing in
 * the admin has turned off.
 */
const maySignIn = async (user: User): Promise<boolean> => {
  const settings = getSettings();

  if (user.userType === UserType.PLEX) {
    if (settings.main.mediaServerLogin === false) {
      return false;
    }
    if (user.id === 1) {
      return true;
    }
    const owner = await getRepository(User).findOneOrFail({
      select: { id: true, plexToken: true, plexId: true },
      where: { id: 1 },
    });
    return (
      !!user.plexId &&
      (user.plexId === owner.plexId ||
        (await new PlexTvAPI(owner.plexToken ?? '').checkUserAccess(
          user.plexId
        )))
    );
  }

  if (user.userType === UserType.LOCAL) {
    return settings.main.localLogin !== false || user.id === 1;
  }

  if (settings.main.mediaServerLogin === false) {
    return false;
  }
  if (user.id === 1) {
    return true;
  }
  // A Jellyfin or Emby account must still exist there, and not be switched
  // off: a passkey is no way around the server's own decision.
  if (!user.jellyfinUserId || !settings.jellyfin.apiKey) {
    return false;
  }
  const account = await new JellyfinAPI(
    getHostname(),
    settings.jellyfin.apiKey
  ).getAccount(user.jellyfinUserId);
  return !!account && !account.Policy?.IsDisabled;
};

passkeyRoutes.post('/login', async (req, res, next) => {
  const body = req.body as { response?: AuthenticationResponseJSON };
  const expectedChallenge = takeChallenge(req.session, 'login');
  const refused = { status: 403, message: 'Passkey sign-in failed.' };

  if (!expectedChallenge || !body.response?.id) {
    return next({
      status: 400,
      message: 'Passkey sign-in expired. Try again.',
    });
  }

  try {
    const repository = getRepository(UserPasskey);
    const passkey = await repository.findOne({
      where: { credentialId: body.response.id },
      relations: { user: true },
    });

    if (!passkey) {
      logger.warn('Sign-in with an unknown passkey', {
        label: 'Auth',
        ip: req.ip,
      });
      return next(refused);
    }

    const { rpID, origin } = relyingParty(req);
    const verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: passkey.credentialId,
        publicKey: fromBase64Url(passkey.publicKey),
        counter: Number(passkey.counter),
        transports: passkey.transports?.split(',').filter(Boolean),
      },
      requireUserVerification: true,
    });

    // The device names who it signed in as; it has to be the passkey's owner.
    const handle = body.response.response.userHandle;
    const handleMatches =
      !handle ||
      Buffer.from(handle, 'base64url').toString('utf8') ===
        `seerr-user-${passkey.user.id}`;

    if (!verification.verified || !handleMatches) {
      logger.warn('Passkey sign-in did not verify', {
        label: 'Auth',
        ip: req.ip,
        userId: passkey.user.id,
      });
      return next(refused);
    }

    if (!(await maySignIn(passkey.user))) {
      logger.warn('Passkey sign-in by someone no longer allowed to sign in', {
        label: 'Auth',
        ip: req.ip,
        userId: passkey.user.id,
      });
      return next({ status: 403, message: 'Access denied.' });
    }

    await repository.update(passkey.id, {
      counter: String(verification.authenticationInfo.newCounter),
      backedUp: verification.authenticationInfo.credentialBackedUp,
      lastUsedAt: new Date(),
    });

    const user = await getRepository(User).findOneOrFail({
      where: { id: passkey.user.id },
    });

    await startSession(req, user.id);

    logger.info('Signed in with a passkey', {
      label: 'Auth',
      userId: user.id,
      passkeyId: passkey.id,
    });

    return res.status(200).json(user.filter());
  } catch (e) {
    logger.warn('Passkey sign-in failed', {
      label: 'Auth',
      ip: req.ip,
      errorMessage: e.message,
    });
    return next(refused);
  }
});

export default passkeyRoutes;
