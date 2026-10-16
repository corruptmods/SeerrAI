import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { isBodyScrollLocked, lockBodyScroll } from './bodyScrollLock';

/*
 * Panels, dialogs and slide-overs each stop the page behind them scrolling.
 * They open and close in any order (a dialog fading out as the AI panel
 * opens, a panel closed by leaving the page while a dialog in it is still
 * up), and the page must scroll again once the last of them is gone.
 */

const page = () => ({ style: { overflow: '', touchAction: '' } });
let body = page();

beforeEach(() => {
  body = page();
});

const locked = () =>
  body.style.overflow === 'hidden' && body.style.touchAction === 'none';

describe('lockBodyScroll', () => {
  it('stops the page scrolling, and lets it scroll again when released', () => {
    const release = lockBodyScroll(body);
    assert.equal(locked(), true);
    release();
    assert.deepEqual(body.style, { overflow: '', touchAction: '' });
  });

  it('keeps the page still until the last of several locks is released', () => {
    const panel = lockBodyScroll(body);
    const dialog = lockBodyScroll(body);
    panel();
    assert.equal(locked(), true);
    dialog();
    assert.deepEqual(body.style, { overflow: '', touchAction: '' });
  });

  it('frees the page whichever order they are released in', () => {
    // The old lock restored what it saw when it locked: the second saw
    // "hidden", and released last it left the page stuck.
    const dialog = lockBodyScroll(body);
    const panel = lockBodyScroll(body);
    dialog();
    panel();
    assert.deepEqual(body.style, { overflow: '', touchAction: '' });
  });

  it('counts a release only once', () => {
    const panel = lockBodyScroll(body);
    const dialog = lockBodyScroll(body);
    panel();
    panel();
    assert.equal(locked(), true);
    dialog();
    assert.equal(locked(), false);
  });

  it('puts back a style the page had set itself', () => {
    body.style.overflow = 'auto';
    const release = lockBodyScroll(body);
    release();
    assert.equal(body.style.overflow, 'auto');
  });

  it('locks again after everything was released', () => {
    lockBodyScroll(body)();
    const again = lockBodyScroll(body);
    assert.equal(locked(), true);
    again();
    assert.equal(locked(), false);
  });
});

describe('isBodyScrollLocked', () => {
  it('says whether a panel or dialog holds the page still', () => {
    assert.equal(isBodyScrollLocked(body), false);
    const panel = lockBodyScroll(body);
    const dialog = lockBodyScroll(body);
    assert.equal(isBodyScrollLocked(body), true);
    panel();
    assert.equal(isBodyScrollLocked(body), true);
    dialog();
    assert.equal(isBodyScrollLocked(body), false);
  });

  it('is not fooled by a style set some other way', () => {
    // Pull to refresh sets touch-action itself while a finger is down.
    body.style.touchAction = 'none';
    assert.equal(isBodyScrollLocked(body), false);
  });
});
