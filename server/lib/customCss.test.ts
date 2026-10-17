import {
  contentSecurityPolicy,
  cssVersion,
  stylePolicy,
} from '@server/lib/customCss';
import express from 'express';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';

/*
 * The Content-Security-Policy sent with every page: stylesheets and fonts
 * come from this server, or from the places the admin's Server CSS names,
 * and nowhere else, whatever a person's own CSS tries.
 */

describe('the page’s Content-Security-Policy', () => {
  it('allows only this server’s stylesheets and fonts with no Server CSS', () => {
    assert.equal(
      contentSecurityPolicy(''),
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
      contentSecurityPolicy(css),
      "style-src 'self' 'unsafe-inline' https://theme-park.dev cdn.example:8443; " +
        "font-src 'self' data: https://theme-park.dev cdn.example:8443 https://fonts.example"
    );
  });

  it('never lets an address add anything but a place to the policy', () => {
    const css = `@import "https://ok.example/a.css; script-src *";
@import "javascript:alert(1)";
@import "data:text/css,a{}";
@import url("https://ok.example/b.css 'unsafe-eval'");`;
    const policy = contentSecurityPolicy(css);
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
      stylePolicy(() => serverCss),
      (_req, res) => {
        res.send('<!doctype html>');
      }
    );
    const first = await request(app).get('/discover');
    assert.equal(
      first.headers['content-security-policy'],
      "style-src 'self' 'unsafe-inline'; font-src 'self' data:"
    );
    serverCss = '@import "https://theme-park.dev/x.css";';
    const second = await request(app).get('/login');
    assert.match(
      second.headers['content-security-policy'],
      /^style-src 'self' 'unsafe-inline' https:\/\/theme-park\.dev;/
    );
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
