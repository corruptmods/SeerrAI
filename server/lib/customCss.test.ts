import { cssVersion, pagePolicy, styleSources } from '@server/lib/customCss';
import express from 'express';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import request from 'supertest';

/*
 * The CSP sent with every page: scripts only from this server or the page's
 * own (by nonce), stylesheets and fonts only from this server or hosts the
 * admin's Server CSS names, whatever a user's own CSS tries, and framing only
 * by this server.
 */

describe('the page’s Content-Security-Policy', () => {
  it('allows only this server’s stylesheets and fonts with no Server CSS', () => {
    assert.equal(
      styleSources(''),
      "style-src 'self' 'unsafe-inline'; font-src 'self' data:"
    );
  });

  it('adds the places the Server CSS brings stylesheets and fonts from', () => {
    const css = `@import url("https://theme-park.dev/css/base/overseerr/nord.css");
@import "https://theme-park.dev/css/theme-options/dark.css";
@import url(//cdn.example:8443/x.css);
@font-face { font-family: X; src: url(https://fonts.example/x.woff2); }
a { background: url(/own.png); }
/* @import "https://commented.example/x.css"; */`;
    assert.equal(
      styleSources(css),
      "style-src 'self' 'unsafe-inline' https://theme-park.dev cdn.example:8443; " +
        "font-src 'self' data: https://theme-park.dev cdn.example:8443 https://fonts.example"
    );
  });

  it('never lets an address add anything but a place to the policy', () => {
    const css = `@import "https://ok.example/a.css; script-src *";
@import "javascript:alert(1)";
@import "data:text/css,a{}";
@import url("https://ok.example/b.css 'unsafe-eval'");`;
    const policy = styleSources(css);
    assert.doesNotMatch(policy, /script-src|unsafe-eval|javascript|data:text/);
    assert.equal(
      policy,
      "style-src 'self' 'unsafe-inline' https://ok.example; font-src 'self' data: https://ok.example"
    );
  });

  it('is sent with every page, following the Server CSS as it changes', async () => {
    let serverCss = '';
    const app = express();
    app.get(
      '*path',
      pagePolicy(() => serverCss),
      (_req, res) => {
        res.send('<!doctype html>');
      }
    );
    const first = await request(app).get('/discover');
    assert.match(
      first.headers['content-security-policy'],
      /; style-src 'self' 'unsafe-inline'; font-src 'self' data:;/
    );
    serverCss = '@import "https://theme-park.dev/x.css";';
    const second = await request(app).get('/login');
    assert.match(
      second.headers['content-security-policy'],
      /; style-src 'self' 'unsafe-inline' https:\/\/theme-park\.dev;/
    );
  });

  it('lets pages run only this server’s scripts and their own, with a new nonce each time', async () => {
    const app = express();
    app.get(
      '*path',
      pagePolicy(() => ''),
      (_req, res) => res.send('ok')
    );
    const policies = await Promise.all(
      ['/discover', '/discover'].map(
        async (page) =>
          (await request(app).get(page)).headers[
            'content-security-policy'
          ] as string
      )
    );
    const nonces = policies.map((policy) => {
      const match = /^script-src 'self' 'nonce-([A-Za-z0-9+/]{22}==)'; /.exec(
        policy
      );
      assert.ok(match, policy);
      return match[1];
    });
    assert.notEqual(nonces[0], nonces[1]);
    for (const policy of policies) {
      assert.doesNotMatch(policy, /unsafe-eval|script-src[^;]*unsafe-inline/);
      assert.match(policy, /; object-src 'none'; base-uri 'self'/);
    }
  });

  it('lets Next.js evaluate code in development only', async () => {
    const app = express();
    app.get(
      '*path',
      pagePolicy(() => '', { dev: true }),
      (_req, res) => res.send('ok')
    );
    const res = await request(app).get('/');
    assert.match(
      res.headers['content-security-policy'],
      /^script-src 'self' 'nonce-[^']+' 'unsafe-eval'; /
    );
  });

  it('lets only this server frame its pages', async () => {
    const app = express();
    app.get(
      '*path',
      pagePolicy(() => ''),
      (_req, res) => res.send('ok')
    );
    const res = await request(app).get('/discover');
    assert.match(
      res.headers['content-security-policy'],
      /; frame-ancestors 'self'$/
    );
    assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
  });

  it('is carried by every script the page writes', () => {
    // Read from source: the document needs the whole app to render.
    const source = readFileSync(
      path.join(process.cwd(), 'src/pages/_document.tsx'),
      'utf8'
    );
    const scripts = source.match(/<script\b[^>]*/g) ?? [];
    assert.ok(scripts.length >= 2);
    for (const script of scripts) {
      assert.match(script, /nonce=\{nonce\}/, script);
    }
    assert.match(source, /<Head nonce=\{nonce\}>/);
    assert.match(source, /<NextScript nonce=\{nonce\} \/>/);
    assert.match(source, /getHeader\('Content-Security-Policy'\)/);
  });
});

describe('the version of a stylesheet', () => {
  it('changes with its text, and is none for none', () => {
    assert.equal(cssVersion(''), null);
    assert.match(cssVersion('a{}') ?? '', /^[0-9a-f]{12}$/);
    assert.equal(cssVersion('a{}'), cssVersion('a{}'));
    assert.notEqual(cssVersion('a{}'), cssVersion('b{}'));
  });
});
