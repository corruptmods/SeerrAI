import type { Notice } from '@server/lib/backfill/notices';
import backfillNotices, { summarize } from '@server/lib/backfill/notices';
import notificationManager from '@server/lib/notifications';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

/*
 * Backfill's news, gathered: a burst of downloads finishing is one
 * notification, grouped by title, sent once things go quiet.
 */

const notice = (over: Partial<Notice>): Notice => ({
  kind: 'finished',
  seriesId: 1,
  title: 'SpongeBob SquarePants',
  what: 'S17E02',
  url: '/backfill/jobs/1',
  ...over,
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

describe('Backfill notices', () => {
  it('says one thing as it is', () => {
    const one = summarize([notice({})]);
    assert.equal(one.subject, 'SpongeBob SquarePants: download finished');
    assert.equal(one.message, 'S17E02');
    assert.equal(one.actionUrl, '/backfill/jobs/1');
  });

  it('says one title’s burst in one, failures first', () => {
    const burst = summarize([
      ...[
        'S17E02',
        'S17E03',
        'S17E11',
        'S17E12',
        'S17E13',
        'S17E14',
        'S17E17',
      ].map((what) => notice({ what })),
      notice({
        kind: 'failed',
        what: 'S17E20',
        detail: 'Nothing downloaded for 1 hour',
      }),
    ]);
    assert.equal(
      burst.subject,
      'SpongeBob SquarePants: 1 download failed, 7 downloads finished'
    );
    assert.equal(
      burst.message,
      'Download failed: S17E20 (Nothing downloaded for 1 hour).\nDownloads finished: S17E02, S17E03, S17E11, S17E12, S17E13, S17E14 and 1 more.'
    );
    assert.equal(burst.actionUrl, '/backfill/series/1');
  });

  it('says several titles in one, a line each', () => {
    const many = summarize([
      notice({}),
      notice({ what: 'S17E03' }),
      notice({ seriesId: 2, title: 'Casper', kind: 'found', what: 'a pack' }),
    ]);
    assert.equal(
      many.subject,
      'Backfill: 1 pack waits for approval, 2 downloads finished'
    );
    assert.equal(
      many.message,
      'SpongeBob SquarePants: 2 downloads finished\nCasper: 1 pack waits for approval'
    );
    assert.equal(many.actionUrl, '/backfill');
  });

  it('waits until things go quiet, but not forever', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const sent: string[] = [];
    mock.method(
      notificationManager,
      'sendNotification',
      (_t: unknown, p: { subject: string }) => {
        sent.push(p.subject);
      }
    );
    const { quietMs, longestMs } = backfillNotices.timing;
    backfillNotices.add(notice({}));
    mock.timers.tick(quietMs - 1000);
    backfillNotices.add(notice({ what: 'S17E03' }));
    mock.timers.tick(quietMs - 1000);
    assert.deepEqual(sent, [], 'still coming in');
    // Something every few minutes: it goes out at the longest wait anyway.
    for (let t = 2 * (quietMs - 1000); t < longestMs; t += 60_000) {
      backfillNotices.add(notice({ what: `S18E0${t}` }));
      mock.timers.tick(60_000);
    }
    assert.equal(sent.length, 1);
    assert.match(sent[0], /^SpongeBob SquarePants: \d+ downloads finished$/);
    assert.equal(backfillNotices.held().length, 0);
  });
});
