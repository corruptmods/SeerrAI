import { discoveryProblem, problemText } from '@server/lib/oidc';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * What an admin is told when a single sign-on provider's discovery address
 * answers "not found" (404): with just a host entered, where Authentik
 * keeps it.
 */

/** As openid-client throws when discovery answers with this status. */
const answered = (status: number) =>
  Object.assign(new Error('"response" is not a conform response'), {
    code: 'OAUTH_RESPONSE_IS_NOT_CONFORM',
    cause: { status },
  });

describe('discovery that answers 404', () => {
  it('says where Authentik keeps it when only the host was entered', () => {
    for (const issuerUrl of [
      'https://auth.example.com',
      'https://auth.example.com/',
    ]) {
      const problem = discoveryProblem(answered(404), issuerUrl);
      assert.deepEqual(problem, {
        problem: 'no-discovery',
        params: { status: 404, origin: 'https://auth.example.com' },
      });
      assert.equal(
        problemText(problem),
        "No sign-in details were found at that address (it answered 404). Check the issuer URL: Seerr reads /.well-known/openid-configuration under it. Some providers give each app its own address: in Authentik it's https://auth.example.com/application/o/<app slug>/, and the provider must be attached to an application."
      );
    }
  });

  it('keeps the port of the address entered', () => {
    assert.deepEqual(
      discoveryProblem(answered(404), 'http://localhost:9000/').params,
      { status: 404, origin: 'http://localhost:9000' }
    );
  });

  it('says nothing more for an address with a path', () => {
    const problem = discoveryProblem(
      answered(404),
      'https://auth.example.com/application/o/seerr/'
    );
    assert.deepEqual(problem, {
      problem: 'no-discovery',
      params: { status: 404 },
    });
    assert.equal(
      problemText(problem),
      'No sign-in details were found at that address (it answered 404). Check the issuer URL: Seerr reads /.well-known/openid-configuration under it.'
    );
  });

  it('says nothing more for another answer', () => {
    assert.deepEqual(
      discoveryProblem(answered(500), 'https://auth.example.com').params,
      { status: 500 }
    );
  });
});
