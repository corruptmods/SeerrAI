import type { SiloAccount } from '@server/api/silo/types';
import { ApiErrorCode } from '@server/constants/error';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { startJobs } from '@server/job/schedule';
import { sendEmailConfirmation } from '@server/lib/emailConfirmation';
import { saveFirstOwner } from '@server/lib/firstOwner';
import { mainAccountOn, takeEmail } from '@server/lib/manageUser';
import { MediaServerChangeError } from '@server/lib/mediaServerAdmin';
import {
  connectAsPrimary,
  hostnameOf,
  primaryServer,
  signInAllowed,
} from '@server/lib/mediaServers';
import { withNewUserDefaults } from '@server/lib/newUserDefaults';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { startSession } from '@server/lib/signIn';
import { SignInLimiter, addressGroupOf } from '@server/lib/signInLimiter';
import type { SiloEpoch } from '@server/lib/silo';
import { siloEpoch } from '@server/lib/silo';
import {
  SiloSignInError,
  assertSiloSignInEpoch,
  cancelSiloDevice,
  checkSiloDevice,
  siloAvatarPath,
  siloPasswordSignIn,
  startSiloDevice,
} from '@server/lib/siloAccounts';
import type { SiloConnection } from '@server/lib/siloConnect';
import {
  SILO_BAD_PASSWORD,
  SILO_NOT_ADMIN,
  finishSiloReset,
  siloAccountToRelink,
  siloAddressOf,
  storeSilo,
  trySilo,
} from '@server/lib/siloConnect';
import logger from '@server/logger';
import { checkAvatarChanged } from '@server/routes/avatarproxy';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';

/*
 * Signing in with a Silo account (/auth/silo): with a name and password, or
 * with a code approved in Silo (its Quick Connect). At first-run setup, the
 * Silo administrator who signs in becomes the owner and Silo the primary
 * server. The same rules as Jellyfin and Emby decide who gets an account:
 * someone new whose name is already another account's is refused and told to
 * sign in with that account and link Silo instead.
 */

const siloAuthRoutes = Router();

const siloLimiter = new SignInLimiter('silo', { capAccount: true });

/** Codes one address may ask Silo for, as wrong passwords are counted. */
const deviceLimiter = new SignInLimiter('silo-device');

const passwordBody = z.object({
  username: z.string().min(1).max(256),
  password: z.string().max(1024).optional().default(''),
  email: z.string().max(256).optional(),
  // Setup only: Silo's address, and optionally an API key to use.
  hostname: z.string().max(256).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  useSsl: z.boolean().optional(),
  urlBase: z.string().max(256).optional(),
  apiKey: z.string().max(512).optional(),
});

const handleBody = z.object({ handle: z.string().regex(/^[a-f0-9]{48}$/) });

/** Answers a failed sign-in: Silo's reason, or the shared error codes. */
const refuse = (next: NextFunction, e: unknown) => {
  if (e instanceof SiloSignInError) {
    switch (e.reason) {
      case 'credentials':
        return next({ status: 401, message: ApiErrorCode.InvalidCredentials });
      case 'notAdmin':
        return next({ status: 403, message: ApiErrorCode.NotAdmin });
      case 'unreachable':
        return next({ status: 502, message: ApiErrorCode.ConnectionError });
      case 'passwordChange':
        return next({
          status: 403,
          message: ApiErrorCode.PasswordChangeRequired,
        });
      default:
        return next({ status: e.status, message: e.message });
    }
  }
  if (e instanceof MediaServerChangeError) {
    return next({ status: e.status, message: e.message });
  }
  logger.error('Silo sign-in failed', {
    label: 'Auth',
    errorMessage: e instanceof Error ? e.message : String(e),
  });
  return next({ status: 500, message: 'Something went wrong.' });
};

/** A refusal with a status and a message (an error code or plain text). */
class Refused extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/** The picture follows Silo when Silo holds their main account. */
const refreshPicture = async (user: User): Promise<void> => {
  if (!user.siloUserId || !mainAccountOn(user, 'silo')) return;
  try {
    const { changed } = await checkAvatarChanged(user, 'silo');
    if (changed || !user.avatar.startsWith('/avatarproxy/silo/')) {
      user.avatar = siloAvatarPath(user.siloUserId, user.avatarVersion);
      await getRepository(User).update(user.id, { avatar: user.avatar });
    }
  } catch (e) {
    logger.error('Could not refresh a Silo picture at sign-in', {
      label: 'Auth',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
  }
};

/**
 * Signs in someone Silo vouched for, outside setup: their account here, made
 * when new users may sign in and nobody else has their name. Their Silo
 * profile is chosen under Linked Accounts.
 */
const signInAccount = async (
  req: Request,
  account: SiloAccount,
  epoch: SiloEpoch,
  { email, password }: { email?: string; password?: string } = {}
): Promise<User> => {
  const settings = getSettings();
  const userRepository = getRepository(User);
  // The account is the Silo's that answered: refused if a reset was marked
  // since, before anything here is read or written for it.
  assertSiloSignInEpoch(epoch);
  let user = await userRepository.findOne({
    where: { siloUserId: account.id },
  });
  // Silo just vouched for this name on the Silo Seerr AI is connected to:
  // an account a different Silo's reset unlinked, with this Silo name, is
  // theirs again.
  if (!user) {
    assertSiloSignInEpoch(epoch);
    const unlinked = await siloAccountToRelink(account);
    assertSiloSignInEpoch(epoch);
    // Only while still unlinked: someone linked it meanwhile keeps it.
    const relinked = unlinked
      ? await userRepository
          .createQueryBuilder()
          .update(User)
          .set({
            siloUserId: account.id,
            siloUsername: account.username,
            siloProfileId: null,
          })
          .where('id = :id AND siloUserId IS NULL', { id: unlinked.id })
          .execute()
      : undefined;
    if (unlinked && relinked?.affected) {
      user = await userRepository.findOneOrFail({
        where: { id: unlinked.id },
      });
      logger.info('Linked a Silo account again after a different Silo', {
        label: 'API',
        ip: req.ip,
        siloUsername: account.username,
      });
    }
  }

  assertSiloSignInEpoch(epoch);
  if (user) {
    const changes: Partial<User> = { siloUsername: account.username };
    if (mainAccountOn(user, 'silo') && user.username === account.username) {
      changes.username = '';
    }
    await userRepository.update(user.id, changes);
    Object.assign(user, changes);
  } else if (!settings.main.newPlexLogin) {
    logger.warn('Silo sign-in refused: this account was not imported', {
      label: 'API',
      ip: req.ip,
      siloUsername: account.username,
    });
    throw new Refused(403, 'Access denied.');
  } else {
    // Their email, else their Silo name, is their password-login name; never
    // one another account already has. Silo vouches only for the name.
    const loginName = email || account.username;
    const vouched = loginName.toLowerCase() === account.username.toLowerCase();
    const free = vouched
      ? await takeEmail(loginName)
      : !(await userRepository.exists({
          where: { email: loginName.toLowerCase() },
        }));
    assertSiloSignInEpoch(epoch);
    if (!free) {
      logger.warn(
        'Silo sign-in refused: another account already has this email or name',
        { label: 'API', ip: req.ip, siloUsername: account.username }
      );
      throw new Refused(403, ApiErrorCode.ExistingAccount);
    }
    user = withNewUserDefaults(
      new User({
        email: loginName,
        siloUserId: account.id,
        siloUsername: account.username,
        permissions: settings.main.defaultPermissions,
        userType: UserType.SILO,
        emailVerified: vouched,
      })
    );
    user.avatar = siloAvatarPath(account.id);
    // A password typed here also signs them in here, as with Jellyfin.
    if (password) {
      await user.setPassword(password);
    }
    assertSiloSignInEpoch(epoch);
    await userRepository.save(user);
    // An email Silo didn't vouch for is confirmed by mail, as with Jellyfin.
    if (!vouched) {
      void sendEmailConfirmation(user);
    }
    logger.info('Created a user for a Silo account', {
      label: 'API',
      ip: req.ip,
      siloUsername: account.username,
    });
  }

  await refreshPicture(user);
  return user;
};

/**
 * Setup with Silo as the primary server: Silo is checked and its key made
 * (or the given one tried), then the administrator who signed in becomes the
 * owner. Everything Silo must answer comes first, so a failure leaves
 * settings as they were.
 */
const setUpWithSilo = async (
  req: Request,
  body: z.infer<typeof passwordBody>
): Promise<User> => {
  const settings = getSettings();
  const userRepository = getRepository(User);
  const address = body.hostname
    ? siloAddressOf(body)
    : siloAddressOf({ ...settings.silo, hostname: settings.silo.ip });
  if (!address.ip) {
    throw new Refused(400, "Enter Silo's address.");
  }

  // Who may become the owner, checked before Seerr AI makes a key in Silo,
  // so a refusal never leaves one behind. With accounts but no primary
  // server (fresh settings), only the owner's own Silo account, or one they
  // lack, may set up the owner, and the email they take must be free.
  const missingAdminUser = !(await userRepository.count());
  const owner = missingAdminUser
    ? null
    : await userRepository.findOne({ where: { id: 1 } });
  const vet = async (admin: SiloAccount): Promise<void> => {
    if (admin.role !== 'admin') {
      throw new SiloSignInError(403, 'notAdmin', 'Not an administrator.');
    }
    if (admin.password_change_required) {
      throw new SiloSignInError(403, 'passwordChange', 'Temporary password.');
    }
    const holder = await userRepository.findOne({
      where: { siloUserId: admin.id },
    });
    const email = (body.email || admin.username).toLowerCase();
    const emailHolder = await userRepository.findOne({
      select: { id: true },
      where: { email },
    });
    if (
      (owner &&
        ((owner.siloUserId && owner.siloUserId !== admin.id) ||
          (holder && holder.id !== owner.id))) ||
      (emailHolder && emailHolder.id !== owner?.id)
    ) {
      logger.warn(
        'Silo sign-in refused: this account may not set up the owner',
        { label: 'API', ip: req.ip, siloUsername: admin.username }
      );
      throw new Refused(403, ApiErrorCode.ExistingAccount);
    }
  };

  let admin: SiloAccount | undefined;
  if (body.apiKey) {
    admin = await siloPasswordSignIn(
      body.username,
      body.password,
      hostnameOf(address)
    );
    await vet(admin);
  }
  // Until the owner and settings are saved, a failure puts the settings
  // back as they were; with a sign-in, it runs while still signed in to
  // Silo, so the key just made is deleted again.
  const mediaServerType = settings.main.mediaServerType;
  let user: User | undefined;
  let who: SiloAccount | undefined;
  const save = async (connection: SiloConnection): Promise<void> => {
    who = admin ?? connection.admin;
    if (!who) {
      throw new Refused(500, 'Something went wrong.');
    }
    let saved: User;
    const { reset, previous } = await storeSilo(
      { ...address, hostname: address.ip },
      connection,
      { connect: true }
    );
    try {
      connectAsPrimary('silo');
      const columns = {
        email: body.email || who.username,
        siloUserId: who.id,
        siloUsername: who.username,
        permissions: Permission.ADMIN,
        userType: UserType.SILO,
        avatar: siloAvatarPath(who.id),
      };
      if (owner) {
        Object.assign(owner, columns);
        saved = await userRepository.save(owner);
      } else {
        saved = await saveFirstOwner(withNewUserDefaults(new User(columns)));
      }
      // A different Silo than before is saved marked resetPending, naming
      // the owner to keep linked to it: until the old one is forgotten
      // (after signing out of Silo, below), nothing signs in through it.
      if (reset) {
        settings.silo.resetPending = {
          userId: saved.id,
          accountId: who.id,
          accountUsername: who.username,
        };
      }
      await settings.save();
    } catch (e) {
      // Exactly as before: the old Silo, with no reset mark.
      settings.restore('silo', previous);
      settings.main.mediaServerType = mediaServerType;
      throw e;
    }
    user = saved;
  };
  try {
    await trySilo(
      {
        ...address,
        hostname: address.ip,
        ...(body.apiKey
          ? { apiKey: body.apiKey }
          : { username: body.username, password: body.password }),
      },
      { vet, confirmReset: true, whileSignedIn: save }
    );
  } catch (e) {
    // Silo's own words for a wrong password or a non-administrator.
    if (e instanceof MediaServerChangeError && e.message === SILO_NOT_ADMIN) {
      throw new SiloSignInError(403, 'notAdmin', e.message);
    }
    if (
      e instanceof MediaServerChangeError &&
      e.message === SILO_BAD_PASSWORD
    ) {
      throw new SiloSignInError(401, 'credentials', e.message);
    }
    throw e;
  }
  if (!user || !who) {
    throw new Refused(500, 'Something went wrong.');
  }
  // Settings and Silo agree on the key now; a different Silo than before
  // forgets the old one's links, keeping the owner linked to this one. If
  // this fails, the reset stays pending and is finished later.
  await finishSiloReset();
  startJobs();
  logger.info('Set up Seerr AI with Silo as the primary server', {
    label: 'API',
    ip: req.ip,
    siloUsername: who.username,
  });
  await refreshPicture(user);
  return user;
};

const respondSignedIn = async (req: Request, res: Response, user: User) => {
  await startSession(req, user.id);
  const fresh = await getRepository(User).findOneOrFail({
    where: { id: user.id },
  });
  return res.status(200).json(fresh.filter());
};

siloAuthRoutes.post('/', async (req, res, next) => {
  const parsed = passwordBody.safeParse(req.body);
  if (!parsed.success) {
    return next({ status: 400, message: 'Enter a username.' });
  }
  const body = parsed.data;
  const settingUp = !primaryServer();
  const noOwner = !settingUp && !(await getRepository(User).count());

  if (!settingUp) {
    if (!signInAllowed('silo')) {
      return next({ status: 403, message: 'Silo sign-in is turned off.' });
    }
    if (body.hostname || body.apiKey) {
      return next({
        status: 400,
        message: "Silo's address is already set up.",
      });
    }
    // With no accounts, only the primary server sets up the owner.
    if (noOwner && primaryServer() !== 'silo') {
      return next({ status: 403, message: ApiErrorCode.ExistingAccount });
    }
  }

  if (!siloLimiter.take(req, res, body.username)) {
    return;
  }
  try {
    let user: User;
    if (settingUp) {
      user = await setUpWithSilo(req, body);
    } else {
      const epoch = siloEpoch();
      const account = await siloPasswordSignIn(body.username, body.password);
      siloLimiter.clear(req, body.username);
      if (noOwner) {
        if (account.role !== 'admin') {
          throw new SiloSignInError(403, 'notAdmin', 'Not an administrator.');
        }
        assertSiloSignInEpoch(epoch);
        user = await saveFirstOwner(
          withNewUserDefaults(
            new User({
              email: body.email || account.username,
              siloUserId: account.id,
              siloUsername: account.username,
              permissions: Permission.ADMIN,
              userType: UserType.SILO,
              avatar: siloAvatarPath(account.id),
            })
          )
        );
      } else {
        user = await signInAccount(req, account, epoch, {
          email: body.email,
          password: body.password,
        });
      }
    }
    siloLimiter.clear(req, body.username);
    return await respondSignedIn(req, res, user);
  } catch (e) {
    // Only a wrong password counts against the name.
    if (!(e instanceof SiloSignInError && e.reason === 'credentials')) {
      siloLimiter.refund(req, body.username);
    }
    if (e instanceof Refused) {
      return next({ status: e.status, message: e.message });
    }
    if (e instanceof SiloSignInError && e.reason === 'credentials') {
      logger.warn('Failed sign-in attempt with incorrect Silo credentials', {
        label: 'Auth',
        ip: req.ip,
      });
    }
    return refuse(next, e);
  }
});

/** Device sign-in needs Silo connected, set up and its sign-in on. */
const deviceSignInOpen = async (next: NextFunction): Promise<boolean> => {
  if (!primaryServer() || !(await getRepository(User).count())) {
    next({
      status: 403,
      message: 'Signing in with a code is not available during setup.',
    });
    return false;
  }
  if (!signInAllowed('silo')) {
    next({ status: 403, message: 'Silo sign-in is turned off.' });
    return false;
  }
  return true;
};

siloAuthRoutes.post('/device/start', async (req, res, next) => {
  if (!(await deviceSignInOpen(next))) return;
  // Each start asks Silo for a code; anyone can ask, so each address is
  // limited.
  if (!deviceLimiter.take(req, res, 'start')) return;
  try {
    return res.status(200).json(await startSiloDevice(addressGroupOf(req.ip)));
  } catch (e) {
    return refuse(next, e);
  }
});

/*
 * Whether the code was approved yet. On approval the person is signed in
 * here and their account returned; the code can't be used again.
 */
siloAuthRoutes.post('/device/check', async (req, res, next) => {
  const parsed = handleBody.safeParse(req.body);
  if (!parsed.success) {
    return next({ status: 400, message: 'Invalid request body.' });
  }
  if (!(await deviceSignInOpen(next))) return;
  try {
    const check = await checkSiloDevice(parsed.data.handle);
    if (check.status !== 'approved') {
      return res.status(200).json(check);
    }
    const user = await signInAccount(req, check.account, check.epoch);
    await startSession(req, user.id);
    const fresh = await getRepository(User).findOneOrFail({
      where: { id: user.id },
    });
    return res.status(200).json({ status: 'approved', user: fresh.filter() });
  } catch (e) {
    if (e instanceof Refused) {
      return next({ status: e.status, message: e.message });
    }
    return refuse(next, e);
  }
});

siloAuthRoutes.post('/device/cancel', async (req, res, next) => {
  const parsed = handleBody.safeParse(req.body);
  if (!parsed.success) {
    return next({ status: 400, message: 'Invalid request body.' });
  }
  await cancelSiloDevice(parsed.data.handle);
  return res.status(204).send();
});

export default siloAuthRoutes;
