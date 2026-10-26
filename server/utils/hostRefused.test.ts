import { hostRefusedMessage, refusedHost } from '@server/utils/hostRefused';
import { AxiosError, AxiosHeaders } from 'axios';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/** ASP.NET's page for a host it doesn't answer to, as Radarr 7 sends it. */
const PAGE =
  '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN""http://www.w3.org/TR/html4/strict.dtd">\r\n' +
  '<HTML><HEAD><TITLE>Bad Request</TITLE>\r\n' +
  '<META HTTP-EQUIV="Content-Type" Content="text/html; charset=us-ascii"></ HEAD >\r\n' +
  '<BODY><h2>Bad Request - Invalid Hostname</h2>\r\n' +
  '<hr><p>HTTP Error 400. The request hostname is invalid.</p>\r\n' +
  '</BODY></HTML>';

const failed = (status: number, data: unknown) => {
  const config = {
    baseURL: 'http://radarr.lan:7878/api/v3',
    url: '/system/status',
    headers: new AxiosHeaders(),
  };
  return new AxiosError('Request failed', 'ERR_BAD_REQUEST', config, null, {
    status,
    statusText: '',
    data,
    headers: {},
    config,
  });
};

describe('a request an app turned away for its host name', () => {
  it('is told by ASP.NET’s page, through the errors wrapping it', () => {
    assert.equal(refusedHost(failed(400, PAGE)), 'radarr.lan');
    const wrapped = new Error('[Radarr] Failed to retrieve system status', {
      cause: failed(400, PAGE),
    });
    assert.equal(refusedHost(wrapped), 'radarr.lan');
  });

  it('is not any other bad request or failure', () => {
    assert.equal(refusedHost(failed(400, [{ errorMessage: 'No' }])), undefined);
    assert.equal(refusedHost(failed(401, PAGE)), undefined);
    assert.equal(refusedHost(new Error('ECONNREFUSED')), undefined);
    assert.equal(refusedHost(undefined), undefined);
  });

  it('says where to fix it', () => {
    const said = hostRefusedMessage('Radarr', 'radarr.lan');
    assert.match(said, /^Radarr doesn't answer to "radarr\.lan"/);
    assert.match(said, /add radarr\.lan to Allowed Hosts in Radarr/);
  });
});
