import { initI18n } from '@server/i18n';
import PreparedEmail from '@server/lib/email';
import { Notification } from '@server/lib/notifications';
import type { AllSettings } from '@server/lib/settings';
import Settings, { getSettings } from '@server/lib/settings';
import settingsRoutes from '@server/routes/settings';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

/*
 * Notification settings pages, behind the real OpenAPI validator, saving
 * and testing as the pages do.
 */

setupTestDb();

let port = 0;
let gotifyPort = 0;
const gotifyMessages: { priority: unknown }[] = [];
const servers: Server[] = [];

before(async () => {
  initI18n();
  const listen = (app: http.RequestListener) =>
    new Promise<number>((resolve) => {
      const server = http.createServer(app).listen(0, () => {
        resolve((server.address() as AddressInfo).port);
      });
      servers.push(server);
    });

  // A stand-in Gotify server: takes any message and keeps it.
  gotifyPort = await listen((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      gotifyMessages.push(JSON.parse(raw));
      res.setHeader('Content-Type', 'application/json');
      res.end('{}');
    });
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // The person testing: test notifications go to them.
    req.user = {
      id: 1,
      email: 'admin@seerr.dev',
      displayName: 'Admin',
    } as unknown as typeof req.user;
    next();
  });
  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateSecurity: false,
    })
  );
  app.use('/api/v1/settings', settingsRoutes);
  app.use(
    (
      err: { status?: number; message: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => res.status(err.status ?? 500).json({ message: err.message })
  );
  port = await listen(app);
});

after(() => servers.forEach((server) => server.close()));

const call = <T = Record<string, unknown>>(
  method: string,
  route: string,
  body?: unknown
) =>
  new Promise<{ status: number; body: T }>((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/api/v1/settings/notifications${route}`,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: raw ? JSON.parse(raw) : undefined,
          })
        );
      }
    );
    req.on('error', reject);
    req.end(payload);
  });

describe('Gotify priority', () => {
  const gotify = (priority: unknown) => ({
    enabled: true,
    embedPoster: false,
    types: Notification.MEDIA_AVAILABLE,
    options: {
      url: `http://127.0.0.1:${gotifyPort}`,
      token: 'token',
      priority,
      locale: 'en',
    },
  });

  beforeEach(() => {
    gotifyMessages.length = 0;
    getSettings().notifications.agents.gotify =
      new Settings().notifications.agents.gotify;
  });

  it('is saved and sent as a whole number from 0 to 10', async () => {
    for (const priority of [0, 5, 10]) {
      const saved = await call('POST', '/gotify', gotify(priority));
      assert.equal(saved.status, 200);
      assert.equal(
        getSettings().notifications.agents.gotify.options.priority,
        priority
      );

      const tested = await call('POST', '/gotify/test', gotify(priority));
      assert.equal(tested.status, 204, JSON.stringify(tested.body));
    }
    assert.deepEqual(
      gotifyMessages.map((message) => message.priority),
      [0, 5, 10]
    );
  });

  it('is refused as anything else, on saving and on testing', async () => {
    // What the old page sent for "high": Number("high") is NaN, which
    // reaches the server as null.
    for (const priority of [null, 'high', '5', 11, -1, 2.5]) {
      const saved = await call('POST', '/gotify', gotify(priority));
      assert.equal(saved.status, 400, `saved ${JSON.stringify(priority)}`);

      const tested = await call('POST', '/gotify/test', gotify(priority));
      assert.equal(tested.status, 400, `tested ${JSON.stringify(priority)}`);
    }
    assert.equal(getSettings().notifications.agents.gotify.options.priority, 5);
    assert.equal(gotifyMessages.length, 0);
  });

  it('starts at 5 on a new server, and a saved one is kept', () => {
    assert.equal(
      new Settings().notifications.agents.gotify.options.priority,
      5
    );

    const saved = new Settings({
      notifications: {
        agents: {
          gotify: {
            enabled: true,
            types: 2,
            options: { url: 'https://gotify', token: 't', priority: 0 },
          },
        },
      },
    } as unknown as AllSettings);
    assert.equal(saved.notifications.agents.gotify.options.priority, 0);
  });
});

describe('testing email', () => {
  const sent: Record<string, unknown>[] = [];

  beforeEach(() => {
    sent.length = 0;
    mock.method(
      PreparedEmail.prototype,
      'send',
      async (options: { locals: Record<string, unknown> }) => {
        sent.push(options.locals);
      }
    );
    getSettings().main.applicationUrl = 'https://seerr.example.com';
    getSettings().notifications.agents.email.options.usePublicLogo = false;
  });

  after(() => {
    mock.restoreAll();
    getSettings().main.applicationUrl = '';
  });

  it('uses the logo choice on the page, saved or not', async () => {
    const email = (usePublicLogo: boolean) => ({
      enabled: true,
      embedPoster: true,
      options: {
        usePublicLogo,
        emailFrom: 'seerr@example.com',
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        secure: false,
        ignoreTls: false,
        requireTls: false,
        allowSelfSigned: false,
        senderName: 'Seerr AI',
      },
    });

    const publicLogo = await call('POST', '/email/test', email(true));
    assert.equal(publicLogo.status, 204, JSON.stringify(publicLogo.body));
    getSettings().notifications.agents.email.options.usePublicLogo = true;
    const ownLogo = await call('POST', '/email/test', email(false));
    assert.equal(ownLogo.status, 204);

    assert.deepEqual(
      sent.map((locals) => locals.logoUrl),
      [
        'https://raw.githubusercontent.com/corruptmods/SeerrAI/main/public/logo_ai_dark.png',
        'https://seerr.example.com/logo_ai_dark.png',
      ]
    );
  });
});
