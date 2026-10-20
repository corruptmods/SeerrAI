import { AxiosError, AxiosHeaders } from 'axios';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createIntl } from 'react-intl';
import {
  messages,
  retryErrorMessage,
  serverIssueText,
} from './requestServerIssue';

const english = createIntl({ locale: 'en', messages: {} });

/** An error as axios gives it for an answer from the server. */
const answered = (status: number, data: unknown) =>
  new AxiosError('Request failed', 'ERR_BAD_REQUEST', undefined, undefined, {
    status,
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
    data,
  });

describe('why a request has no server to go to', () => {
  it('says what happened, and what a request manager can do', () => {
    const removed = {
      reason: 'removed',
      service: 'radarr',
      usesDefault: true,
    } as const;

    assert.equal(
      serverIssueText(english, removed, false, false),
      'Its Radarr server was removed.'
    );
    assert.equal(
      serverIssueText(english, removed, true, true),
      'Its 4K Radarr server was removed. Retry sends it to the default 4K Radarr server.'
    );
    assert.equal(
      serverIssueText(
        english,
        { ...removed, service: 'sonarr', usesDefault: false },
        false,
        true
      ),
      'Its Sonarr server was removed. Edit it to choose another server, then retry.'
    );
    assert.equal(
      serverIssueText(
        english,
        { reason: 'none', service: 'lidarr', usesDefault: false },
        // Lidarr has no 4K servers.
        true,
        true
      ),
      'No Lidarr server is set up. Add one in Settings → Services, then retry.'
    );
  });

  it('is in the language of the page', () => {
    const french = createIntl({
      locale: 'fr',
      // Only the one message is given here.
      onError: () => undefined,
      messages: {
        [messages.removed.id]: 'Son serveur {service} a été supprimé.',
      },
    });

    assert.equal(
      serverIssueText(
        french,
        { reason: 'removed', service: 'radarr', usesDefault: false },
        false,
        false
      ),
      'Son serveur Radarr a été supprimé.'
    );
  });
});

describe('why a retry was refused', () => {
  it('says so in the page’s language when there was no server to send it to', () => {
    const refused = answered(409, {
      message: 'This request has no Radarr server to go to.',
      code: 'chooseServer',
      serverIssue: {
        reason: 'noDefault',
        service: 'radarr',
        usesDefault: false,
      },
    });

    assert.equal(
      retryErrorMessage(refused, english, false, 'Something went wrong.'),
      'No Radarr server is set as the default. Edit it to choose another server, then retry.'
    );
  });

  it("gives the server's reason otherwise, or the fallback", () => {
    assert.equal(
      retryErrorMessage(
        answered(409, {
          message: 'This title is blocklisted, so it cannot be retried.',
        }),
        english,
        false,
        'Something went wrong.'
      ),
      'This title is blocklisted, so it cannot be retried.'
    );
    assert.equal(
      retryErrorMessage(
        new Error('offline'),
        english,
        false,
        'Something went wrong.'
      ),
      'Something went wrong.'
    );
  });
});
