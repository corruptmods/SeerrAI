import { AxiosError, AxiosHeaders } from 'axios';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createIntl } from 'react-intl';
import { aiErrorMessage } from './aiErrorMessage';

const refused = (data: unknown) =>
  new AxiosError('failed', 'ERR_BAD_REQUEST', undefined, undefined, {
    status: 429,
    data,
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
  });

describe("an AI feature's refusal", () => {
  const german = createIntl({
    locale: 'de',
    messages: {
      'utils.aiErrorMessage.limit':
        'Du hast alle {limit} KI-Antworten für heute verbraucht.',
      'utils.aiErrorMessage.off': 'Diese KI-Funktion ist ausgeschaltet.',
    },
  });

  it("is shown in the person's language when the server gives its code", () => {
    assert.equal(
      aiErrorMessage(
        refused({
          message: "You have used all 3 of today's AI answers.",
          code: 'limit',
          values: { limit: 3 },
        }),
        'Failed.',
        german
      ),
      'Du hast alle 3 KI-Antworten für heute verbraucht.'
    );
    assert.equal(
      aiErrorMessage(
        refused({ message: 'This AI feature is turned off.', code: 'off' }),
        'Failed.',
        german
      ),
      'Diese KI-Funktion ist ausgeschaltet.'
    );
  });

  it("is the server's own words for anything without a code it knows", () => {
    assert.equal(
      aiErrorMessage(
        refused({ message: 'Claude rejected the API key.' }),
        'Failed.',
        german
      ),
      'Claude rejected the API key.'
    );
    assert.equal(
      aiErrorMessage(
        refused({ message: 'Something new.', code: 'unheardOf' }),
        'Failed.',
        german
      ),
      'Something new.'
    );
    assert.equal(aiErrorMessage(new Error('x'), 'Failed.', german), 'Failed.');
  });
});
