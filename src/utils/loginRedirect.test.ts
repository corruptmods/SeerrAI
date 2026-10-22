import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loginUrl, safeRedirect } from './loginRedirect';

describe('safeRedirect', () => {
  it('keeps a page on this site, with its query and anchor', () => {
    for (const path of [
      '/tv/361251',
      '/discover/movies?genre=28&sortBy=popularity.desc',
      '/movie/549263#cast',
      '/collection/10',
    ]) {
      assert.equal(safeRedirect(path), path);
    }
  });

  it('goes home for anything that could leave the site', () => {
    for (const target of [
      undefined,
      '',
      ['/a', '/b'],
      'tv/1',
      'https://example.com',
      '//example.com',
      '/\\example.com',
      '/\t/example.com',
      'javascript:alert(1)',
      '/.//example.com',
      '/a/..//example.com',
      '/a\\..\\\\example.com',
      '/%2e//example.com',
    ]) {
      assert.equal(safeRedirect(target), '/', JSON.stringify(target));
    }
  });

  it('never goes back to the sign-in page', () => {
    for (const target of [
      '/login',
      '/login?redirect=%2Fmovie%2F1',
      '/login/plex/loading',
      '/LOGIN',
      '/./login',
      '/a/../login',
    ]) {
      assert.equal(safeRedirect(target), '/', target);
    }
    assert.equal(safeRedirect('/loginhelp'), '/loginhelp');
  });
});

describe('loginUrl', () => {
  it('carries the page through sign-in and back', () => {
    const path = '/discover/tv?keywords=1%2C2&sortBy=first_air_date.desc#top';
    const redirect = new URL(
      loginUrl(path),
      'http://localhost'
    ).searchParams.get('redirect');

    assert.equal(safeRedirect(redirect), path);
  });

  it('is the plain sign-in page from home or from sign-in itself', () => {
    assert.equal(loginUrl(), '/login');
    assert.equal(loginUrl('/'), '/login');
    assert.equal(loginUrl('/login'), '/login');
    assert.equal(loginUrl('/login?redirect=%2Fmovie%2F1'), '/login');
    assert.equal(loginUrl('//example.com'), '/login');
  });
});
