import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SCHEDULE_CHOICES, scheduleFor } from './schedule';

// When a six-field schedule runs within a day, read plainly: each second of
// the day whose seconds, minutes and hours fields match.
const runsInADay = (schedule: string): number[] => {
  const [s, m, h] = schedule.split(' ');
  const matches = (field: string, value: number) =>
    field === '*' ||
    (field.startsWith('*/')
      ? value % Number(field.slice(2)) === 0
      : Number(field) === value);
  const runs: number[] = [];
  for (let t = 0; t < 86400; t++) {
    if (
      matches(s, t % 60) &&
      matches(m, Math.floor(t / 60) % 60) &&
      matches(h, Math.floor(t / 3600))
    ) {
      runs.push(t);
    }
  }
  return runs;
};

describe('job schedules', () => {
  it('repeats evenly, as often as each choice says', () => {
    const unit = { seconds: 1, minutes: 60, hours: 3600 } as const;
    for (const interval of ['seconds', 'minutes', 'hours'] as const) {
      for (const every of SCHEDULE_CHOICES[interval]) {
        const runs = runsInADay(scheduleFor(interval, every));
        const gap = every * unit[interval];
        assert.equal(runs.length, 86400 / gap, `${every} ${interval}`);
        // The last run of the day and the first of the next are as far apart.
        runs.push(runs[0] + 86400);
        for (let i = 1; i < runs.length; i++) {
          assert.equal(runs[i] - runs[i - 1], gap, `${every} ${interval}`);
        }
      }
    }
  });

  it('runs daily, or weekly on a day of the week', () => {
    assert.equal(scheduleFor('days', 1), '0 0 1 * * *');
    assert.equal(scheduleFor('days', 7), '0 0 1 * * 0');
  });

  it('offers nothing that would not repeat evenly', () => {
    assert.throws(() => scheduleFor('hours', 18));
    assert.throws(() => scheduleFor('seconds', 45));
    assert.throws(() => scheduleFor('days', 3));
  });
});
