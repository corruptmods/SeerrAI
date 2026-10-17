import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pickNotice } from './NoticeQueue';

const at = 10_000;
const show = { state: 'show' as const, since: at };
const hide = { state: 'hide' as const, since: at };
const pending = (since = at) => ({ state: 'pending' as const, since });

describe('pickNotice', () => {
  it('shows the most important notice with something to say', () => {
    assert.deepEqual(
      pickNotice({ passkey: show, pushOptIn: show }, undefined, at),
      { next: 'pushOptIn' }
    );
  });

  it('puts a seasonal theme’s note after everything else', () => {
    assert.deepEqual(
      pickNotice({ seasonal: show, passkey: show }, undefined, at),
      { next: 'passkey' }
    );
    assert.deepEqual(
      pickNotice({ seasonal: show, passkey: hide }, 'passkey', at),
      { next: 'seasonal' }
    );
  });

  it('shows the next one once the first is dealt with', () => {
    assert.deepEqual(
      pickNotice({ passkey: show, pushOptIn: hide }, 'pushOptIn', at),
      { next: 'passkey' }
    );
  });

  it('keeps what is showing when something more important turns up', () => {
    assert.deepEqual(
      pickNotice({ accountWarning: show, passkey: show }, 'passkey', at),
      { next: 'passkey' }
    );
  });

  it('holds back later notices while an earlier one is still loading', () => {
    assert.deepEqual(
      pickNotice(
        { pushOptIn: pending(at - 1000), passkey: show },
        undefined,
        at
      ),
      { recheckIn: 2000 }
    );
  });

  it('stops waiting on a notice that never finishes loading', () => {
    assert.deepEqual(
      pickNotice(
        { pushOptIn: pending(at - 5000), passkey: show },
        undefined,
        at
      ),
      { next: 'passkey' }
    );
  });

  it('shows nothing when nothing has anything to say', () => {
    assert.deepEqual(
      pickNotice({ pushOptIn: hide, passkey: hide }, undefined, at),
      {}
    );
  });

  it('puts an app update in front of everything', () => {
    assert.deepEqual(
      pickNotice(
        { appUpdated: show, accountWarning: show, watchSuggestions: show },
        undefined,
        at
      ),
      { next: 'appUpdated' }
    );
  });

  it('lets an app update in even while another notice is showing', () => {
    assert.deepEqual(
      pickNotice({ appUpdated: show, passkey: show }, 'passkey', at),
      { next: 'appUpdated' }
    );
  });
});
