import { initI18n } from '@server/i18n';
import { Notification } from '@server/lib/notifications';
import GotifyAgent from '@server/lib/notifications/agents/gotify';
import notificationHttp, {
  NOTIFICATION_TIMEOUT_MS,
} from '@server/lib/notifications/http';
import type { NotificationAgentGotify } from '@server/lib/settings';
import logger from '@server/logger';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

/*
 * A notification service that takes the connection and never answers: the
 * notification gives up instead of waiting for good, and the log says why.
 */

let silentPort = 0;
const silent = http.createServer(() => {
  // Never answers.
});

before(async () => {
  initI18n();
  await new Promise<void>((resolve) => silent.listen(0, resolve));
  silentPort = (silent.address() as AddressInfo).port;
});

after(() => {
  silent.closeAllConnections();
  silent.close();
});

describe('a notification service that never answers', () => {
  it('has a time limit', () => {
    assert.equal(notificationHttp.defaults.timeout, NOTIFICATION_TIMEOUT_MS);
    assert.ok(NOTIFICATION_TIMEOUT_MS > 0);
  });

  it('is given up on, and logged as such', async (t) => {
    // The real limit is 15 seconds; a test needn't wait that long.
    t.after(() => {
      notificationHttp.defaults.timeout = NOTIFICATION_TIMEOUT_MS;
    });
    notificationHttp.defaults.timeout = 200;
    const errors = t.mock.method(logger, 'error', () => logger);

    const agent = new GotifyAgent({
      enabled: true,
      embedPoster: false,
      types: Notification.MEDIA_AVAILABLE,
      options: {
        url: `http://127.0.0.1:${silentPort}`,
        token: 'secret-token',
        priority: 5,
        locale: 'en',
      },
    } as NotificationAgentGotify);

    const started = Date.now();
    const sent = await agent.send(Notification.TEST_NOTIFICATION, {
      notifySystem: true,
      notifyAdmin: false,
      subject: 'Test',
    });
    assert.equal(sent, false);
    assert.ok(Date.now() - started < 5000, 'waited too long');

    assert.equal(errors.mock.callCount(), 1);
    const [line, meta] = errors.mock.calls[0].arguments as unknown as [
      string,
      { errorMessage: string },
    ];
    assert.equal(line, 'Error sending Gotify notification');
    assert.equal(
      meta.errorMessage,
      `No answer from 127.0.0.1:${silentPort} within 0.2 seconds; gave up`
    );
    // The token in the address stays out of the log.
    assert.doesNotMatch(JSON.stringify(meta), /secret-token/);
  });
});
