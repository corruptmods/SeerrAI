import PlexAPI from '@server/api/plexapi';
import dataSource, { getRepository } from '@server/datasource';
import DiscoverSlider from '@server/entity/DiscoverSlider';
import { Session } from '@server/entity/Session';
import { User } from '@server/entity/User';
import { initI18n } from '@server/i18n';
import { startJobs } from '@server/job/schedule';
import agent from '@server/lib/agent';
import backfill from '@server/lib/backfill/engine';
import backfillNotices from '@server/lib/backfill/notices';
import resourceMonitor from '@server/lib/containerResources';
import { pagePolicy } from '@server/lib/customCss';
import { splitEmbyData } from '@server/lib/embySplit';
import { isConnected, rememberJellyfinAdmins } from '@server/lib/mediaServers';
import { musicReady } from '@server/lib/music/access';
import { applyNetworkSettings } from '@server/lib/networkSettings';
import notificationManager from '@server/lib/notifications';
import DiscordAgent from '@server/lib/notifications/agents/discord';
import EmailAgent from '@server/lib/notifications/agents/email';
import GotifyAgent from '@server/lib/notifications/agents/gotify';
import NtfyAgent from '@server/lib/notifications/agents/ntfy';
import PushbulletAgent from '@server/lib/notifications/agents/pushbullet';
import PushoverAgent from '@server/lib/notifications/agents/pushover';
import SlackAgent from '@server/lib/notifications/agents/slack';
import TelegramAgent from '@server/lib/notifications/agents/telegram';
import WebhookAgent from '@server/lib/notifications/agents/webhook';
import WebPushAgent from '@server/lib/notifications/agents/webpush';
import checkOverseerrMerge from '@server/lib/overseerrMerge';
import playlists from '@server/lib/playlists';
import { sessionStoreFor } from '@server/lib/sessionStore';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import apiPathCase from '@server/middleware/apiPathCase';
import { unlessApiKey } from '@server/middleware/auth';
import clearCookies from '@server/middleware/clearcookies';
import { csrfWhileOn } from '@server/middleware/csrf';
import { aiChatBody, jsonBody } from '@server/middleware/jsonBody';
import privateAnswers from '@server/middleware/privateAnswers';
import secureCookies from '@server/middleware/secureCookies';
import warmPosters from '@server/middleware/warmPosters';
import routes from '@server/routes';
import avatarproxy from '@server/routes/avatarproxy';
import flags from '@server/routes/flags';
import imageproxy, { useSessionForImages } from '@server/routes/imageproxy';
import { swPrecacheHandler } from '@server/routes/swPrecache';
import { appDataPermissions } from '@server/utils/appDataVolume';
import { getAppVersion } from '@server/utils/appVersion';
import { isPgsql } from '@server/utils/dbType';
import { rollBackOnRelease } from '@server/utils/nestedTransaction';
import { liveProxyTrust } from '@server/utils/trustedProxies';
import '@server/utils/userAgent';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import session from 'express-session';
import fs from 'fs/promises';
import yaml from 'js-yaml';
import next from 'next';
import path from 'path';
import swaggerUi from 'swagger-ui-express';
import zlib from 'zlib';

const API_SPEC_PATH = path.join(__dirname, '../seerr-api.yml');

logger.info(`Starting Seerr AI version ${getAppVersion()}`);
const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

// Log unhandled rejections instead of letting Node stop the server. Only
// message and stack: API client errors carry the request, API key included.
process.on('unhandledRejection', (reason) => {
  logger.error('A background task failed with nothing to catch it', {
    label: 'Server',
    errorMessage: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

// Log Node warnings (library deprecations, listener leaks) with their source,
// so they show in Settings → Logs, not only container output. Each once per
// run.
const warningsTold = new Set<string>();
process.on('warning', (warning) => {
  const key = `${warning.name}:${warning.message}`;
  if (warningsTold.has(key)) return;
  warningsTold.add(key);
  logger.warn(`Node warning: ${warning.message}`, {
    label: 'Server',
    warning: warning.name,
    code: (warning as Error & { code?: string }).code,
    stack: warning.stack,
  });
});

if (!appDataPermissions()) {
  logger.error(
    'Something went wrong while checking config folder! Please ensure the config folder is set up properly.\nhttps://docs.seerr.dev/getting-started'
  );
}

app
  .prepare()
  .then(async () => {
    await checkOverseerrMerge();

    const dbConnection = dataSource.isInitialized
      ? dataSource
      : await dataSource.initialize();
    rollBackOnRelease(dbConnection);

    if (process.env.NODE_ENV === 'production') {
      if (isPgsql) {
        await dbConnection.runMigrations();
      } else {
        await dbConnection.query('PRAGMA foreign_keys=OFF');
        await dbConnection.runMigrations();
        await dbConnection.query('PRAGMA foreign_keys=ON');
      }
    }

    const settings = await getSettings().load();

    initI18n();

    await applyNetworkSettings(settings.network);

    // On Emby servers, move Emby ids to their own columns once, before anything
    // reads them.
    await splitEmbyData();

    // Store the owner's account on Jellyfin/Emby servers set up before it was
    // stored with them.
    await rememberJellyfinAdmins();

    if (
      isConnected('plex') &&
      settings.plex.libraries.length > 1 &&
      !settings.plex.libraries[0].type
    ) {
      const userRepository = getRepository(User);
      const admin = await userRepository.findOne({
        select: { id: true, plexToken: true },
        where: { id: 1 },
      });

      if (admin) {
        logger.info('Migrating Plex libraries to include media type', {
          label: 'Settings',
        });

        const plexapi = new PlexAPI({ plexToken: admin.plexToken });

        try {
          await plexapi.syncLibraries();
        } catch {
          // Keep existing libraries so the migration retries next startup
          // instead of discarding the configuration.
          logger.warn(
            'Failed to migrate Plex libraries; will retry on next startup',
            { label: 'Settings' }
          );
        }
      }
    }

    notificationManager.registerAgents([
      new DiscordAgent(),
      new EmailAgent(),
      new GotifyAgent(),
      new NtfyAgent(),
      new PushbulletAgent(),
      new PushoverAgent(),
      new SlackAgent(),
      new TelegramAgent(),
      new WebhookAgent(),
      new WebPushAgent(),
    ]);

    // Flush batched notifications before shutdown instead of losing them,
    // allowing a moment to send.
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        // Backfill's batched notices first, so they join the rest.
        backfillNotices.flush();
        notificationManager.flush();
        setTimeout(() => process.exit(0), 3000).unref();
      });
    }

    // Seerr's own CPU and memory, for the health page graphs.
    resourceMonitor.start();

    const userRepository = getRepository(User);
    const totalUsers = await userRepository.count();
    if (totalUsers > 0) {
      // A Backfill search interrupted by the restart is no longer running.
      await backfill.unstickSearches().catch((e) =>
        logger.warn('Could not reset Backfill searches cut short', {
          label: 'Server',
          errorMessage: e instanceof Error ? e.message : String(e),
        })
      );
      startJobs();
      // Resume finding and requesting playlist songs now rather than at the
      // next hourly sync.
      if (musicReady()) {
        playlists.kick();
      }
      // The admin agent resumes its queue and subscribes to empty searches.
      agent.init().catch((e) =>
        logger.error('The admin agent could not start', {
          label: 'Agent',
          errorMessage: e instanceof Error ? e.message : String(e),
        })
      );
    } else {
      logger.info(
        `Skipping starting the scheduled jobs as we have no Plex/Jellyfin/Emby servers setup yet`,
        {
          label: 'Server',
        }
      );
    }

    await DiscoverSlider.bootstrapSliders();

    const server = express();
    server.disable('x-powered-by');
    // Follows Settings → Network as it is saved.
    server.set('trust proxy', liveProxyTrust);
    // Compress text responses (pages, scripts, styles, API JSON). Brotli where
    // accepted: level 5 is about as fast as gzip and much smaller; top levels
    // are too slow per request. Images pass through untouched.
    server.use(
      compression({
        brotli: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } },
      })
    );
    // The API base path as the spec writes it, whatever case it came in.
    server.use(apiPathCase);
    // Every cookie is Secure for a browser on https (an https Application
    // URL's host included); other hosts over plain http work as before.
    server.use(secureCookies);
    server.use(cookieParser());
    // AI Search reads its body after the session is known (below), since an
    // attached photo may exceed the usual limit.
    server.use(jsonBody);
    server.use(express.urlencoded({ extended: true }));
    server.use(csrfWhileOn());

    const sessionRepository = getRepository(Session);
    const sessionStore = sessionStoreFor(sessionRepository);
    const sessions = session({
      secret: settings.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        maxAge: 1000 * 60 * 60 * 24 * 30,
        httpOnly: true,
        // Lax keeps people signed in when they arrive from a link; with CSRF
        // protection on, its token guards every change.
        sameSite: 'lax',
        secure: 'auto',
      },
      store: sessionStore,
    });
    // API key requests belong to the key alone, so their session cookie is
    // never read, changed or ended.
    server.use('/api', unlessApiKey(sessions));
    server.use('/api', privateAnswers);
    server.use(aiChatBody);
    // The image cache only accepts new images for signed-in users.
    useSessionForImages({
      store: sessionStore,
      secret: settings.sessionSecret,
    });
    const apiSpecContent = await fs.readFile(API_SPEC_PATH, 'utf-8');
    const apiDocs = yaml.load(apiSpecContent) as Record<string, unknown>;
    server.use('/api-docs', swaggerUi.serve, swaggerUi.setup(apiDocs));
    server.use(
      OpenApiValidator.middleware({
        apiSpec: API_SPEC_PATH,
        validateRequests: true,
      })
    );
    // Convert dates to strings before OpenAPI response validation, which
    // otherwise sees objects and fails.
    server.use((_req, res, next) => {
      const original = res.json;
      res.json = function jsonp(json) {
        return original.call(this, JSON.parse(JSON.stringify(json)));
      };
      next();
    });
    // Title pages start warming their posters into the image cache.
    server.use('/api/v1', warmPosters, routes);

    // No cookies, so CDNs can cache them.
    server.use('/imageproxy', clearCookies, imageproxy);
    server.use('/avatarproxy', clearCookies, avatarproxy);
    server.use('/flags', clearCookies, flags);

    // Chunk list for the service worker to precache. Registered before the
    // Next.js catch-all.
    server.get('/sw-precache.json', swPrecacheHandler);

    // Pages may load scripts only from here, stylesheets and fonts only from
    // here and the hosts the admin's Server CSS names, and may be framed only
    // here (server/lib/customCss.ts).
    server.get(
      '*path',
      pagePolicy(() => settings.appearance.serverCss ?? '', { dev }),
      (req, res) => handle(req, res)
    );
    server.use(
      (
        err: { status: number; message: string; errors: string[] },
        req: Request,
        res: Response,
        next: NextFunction
      ) => {
        if (res.headersSent) {
          return next(err);
        }
        res.status(err.status || 500).json({
          message: err.message,
          errors: err.errors,
          // Siri's shortcut speaks `say`, so API spec rejections are spoken
          // too.
          ...(req.originalUrl.startsWith('/api/v1/now-playing')
            ? {
                say:
                  (err.status || 500) < 500
                    ? 'The shortcut sent something Seerr could not read. Add it again from your Siri page.'
                    : 'Something went wrong. Try again in a moment.',
              }
            : {}),
        });
      }
    );

    const port = Number(process.env.PORT) || 5055;
    const host = process.env.HOST;
    let httpServer;
    if (host) {
      httpServer = server.listen(port, host, () => {
        logger.info(`Server ready on ${host} port ${port}`, {
          label: 'Server',
        });
      });
    } else {
      httpServer = server.listen(port, () => {
        logger.info(`Server ready on port ${port}`, {
          label: 'Server',
        });
      });
    }
    httpServer.on('error', (err) => {
      logger.error('Failed to start server', {
        label: 'Server',
        message: err.message,
      });
      process.exit(1);
    });
  })
  .catch((err) => {
    logger.error(err.stack);
    process.exit(1);
  });
