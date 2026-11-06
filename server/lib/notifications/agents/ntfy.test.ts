import type { MediaRequest } from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';
import { initI18n } from '@server/i18n';
import { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import NtfyAgent from '@server/lib/notifications/agents/ntfy';
import notificationHttp from '@server/lib/notifications/http';
import {
  requestFingerprint,
  verifyActionToken,
} from '@server/lib/requestActionTokens';
import type { NotificationAgentNtfy } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

/*
 * ntfy's Approve and Decline buttons: http actions the ntfy app sends to the
 * Application URL with a one-time token. Only when turned on and the address
 * is known.
 */

const main = getSettings().main;
const savedUrl = main.applicationUrl;

const agentWith = (options: Partial<NotificationAgentNtfy['options']>) =>
  new NtfyAgent({
    enabled: true,
    embedPoster: false,
    types: Notification.MEDIA_PENDING,
    options: {
      url: 'https://ntfy.example',
      topic: 'requests',
      locale: 'en',
      ...options,
    },
  });

const pending: NotificationPayload = {
  subject: 'Harbour Lights (2020)',
  notifySystem: true,
  notifyAdmin: true,
  request: {
    id: 31,
    requestedBy: { displayName: 'Someone' } as User,
  } as MediaRequest,
};

interface HttpAction {
  action: string;
  label: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  clear: boolean;
}

const actionsOf = (
  agent: NtfyAgent,
  type = Notification.MEDIA_PENDING,
  payload = pending
) =>
  (agent['buildPayload'](type, payload) as { actions?: HttpAction[] }).actions;

before(() => {
  initI18n();
});

beforeEach(() => {
  main.applicationUrl = 'https://seerr.example';
});

after(() => {
  main.applicationUrl = savedUrl;
});

describe('ntfy Approve and Decline buttons', () => {
  it('call the Application URL with a token for each, in the body only', () => {
    const actions = actionsOf(
      agentWith({ approvalButtons: true, approveAsUserId: 4 })
    );

    assert.ok(actions);
    assert.deepEqual(
      actions.map(({ action, label, url, method, headers, clear }) => ({
        action,
        label,
        url,
        method,
        headers,
        clear,
      })),
      ['Approve', 'Decline'].map((label) => ({
        action: 'http',
        label,
        url: 'https://seerr.example/api/v1/request/action',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        clear: true,
      }))
    );

    const claims = actions.map((a) =>
      verifyActionToken(JSON.parse(a.body).token)
    );
    assert.deepEqual(
      claims.map((c) => [c?.requestId, c?.action, c?.userId, c?.agent]),
      [
        [31, 'approve', 4, 'ntfy'],
        [31, 'decline', 4, 'ntfy'],
      ]
    );
  });

  it('carry the request as the notification described it', () => {
    const [approve] = actionsOf(agentWith({ approvalButtons: true }))!;
    assert.equal(
      verifyActionToken(JSON.parse(approve.body).token)?.requestState,
      requestFingerprint(pending.request!)
    );
  });

  it('make one path from an Application URL ending in a slash', () => {
    main.applicationUrl = 'https://seerr.example/sub//';
    const [approve] = actionsOf(agentWith({ approvalButtons: true }))!;
    assert.equal(
      approve.url,
      'https://seerr.example/sub/api/v1/request/action'
    );
  });

  it('act as the owner when no account is chosen', () => {
    const [approve] = actionsOf(agentWith({ approvalButtons: true }))!;
    assert.equal(verifyActionToken(JSON.parse(approve.body).token)?.userId, 1);
  });

  it('are left off unless turned on', () => {
    assert.equal(actionsOf(agentWith({})), undefined);
    assert.equal(actionsOf(agentWith({ approvalButtons: false })), undefined);
  });

  it('are left off without an Application URL for the phone to call', () => {
    main.applicationUrl = '';
    assert.equal(actionsOf(agentWith({ approvalButtons: true })), undefined);
  });

  it('are only on requests waiting for approval', () => {
    const agent = agentWith({ approvalButtons: true });
    assert.equal(actionsOf(agent, Notification.MEDIA_APPROVED), undefined);
    assert.equal(
      actionsOf(agent, Notification.MEDIA_PENDING, {
        ...pending,
        request: undefined,
      }),
      undefined
    );
  });

  it('go out with the notification', async (t) => {
    const post = t.mock.method(notificationHttp, 'post', async () => ({
      data: {},
    }));

    assert.equal(
      await agentWith({ approvalButtons: true }).send(
        Notification.MEDIA_PENDING,
        pending
      ),
      true
    );

    const [url, body] = post.mock.calls[0].arguments as unknown as [
      string,
      { topic: string; actions: HttpAction[] },
    ];
    assert.equal(url, 'https://ntfy.example');
    assert.equal(body.topic, 'requests');
    assert.equal(body.actions.length, 2);
    // The token never in an address, where it would be logged.
    for (const action of body.actions) {
      assert.ok(!action.url.includes(JSON.parse(action.body).token));
    }
  });
});
