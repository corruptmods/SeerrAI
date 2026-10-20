import type { SeasonCalendar, SeasonsSettings } from '@server/lib/seasons';
import {
  MOVING_SEASONS,
  SEASON_DEFAULTS,
  SEASON_IDS,
  activeSeason,
  cleanSeasonNote,
  cleanSeasons,
  localDay,
  seasonCalendar,
  seasonDates,
  seasonSettings,
  shownSeason,
  upcomingDates,
} from '@server/lib/seasons';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * Seasonal themes: which seasons run, on which days, and which one a
 * person sees today.
 */

const defaults = seasonCalendar(SEASON_DEFAULTS);
const everything = seasonCalendar(
  Object.fromEntries(
    SEASON_IDS.map((id) => [id, { ...SEASON_DEFAULTS[id], enabled: true }])
  ) as SeasonsSettings
);
const on = (day: string, calendar: SeasonCalendar = defaults) =>
  activeSeason(calendar, day)?.id;

describe('the seasons a new server has', () => {
  it('are Halloween, Holidays, New Year and Lunar New Year', () => {
    assert.deepEqual(SEASON_IDS, [
      'halloween',
      'holidays',
      'newyear',
      'lunarnewyear',
    ]);
    assert.deepEqual(Object.keys(SEASON_DEFAULTS), SEASON_IDS);
  });

  it('runs Halloween, Holidays and New Year, and not Lunar New Year', () => {
    assert.deepEqual(
      defaults.map((season) => season.id),
      ['halloween', 'holidays', 'newyear']
    );
    assert.deepEqual(SEASON_DEFAULTS.halloween, {
      enabled: true,
      start: '10-24',
      end: '11-01',
    });
    assert.deepEqual(SEASON_DEFAULTS.holidays, {
      enabled: true,
      start: '12-01',
      end: '12-28',
    });
    assert.deepEqual(SEASON_DEFAULTS.newyear, {
      enabled: true,
      start: '12-29',
      end: '01-02',
    });
    assert.deepEqual(SEASON_DEFAULTS.lunarnewyear, { enabled: false });
  });

  it('starts and ends each season on the days it says, both included', () => {
    assert.equal(on('2026-10-23'), undefined);
    assert.equal(on('2026-10-24'), 'halloween');
    assert.equal(on('2026-11-01'), 'halloween');
    assert.equal(on('2026-11-02'), undefined);
    assert.equal(on('2026-11-30'), undefined);
    assert.equal(on('2026-12-01'), 'holidays');
    assert.equal(on('2026-12-28'), 'holidays');
    assert.equal(on('2026-06-15'), undefined);
    assert.equal(on('2026-06-15', everything), undefined);
  });
});

describe('a season across New Year', () => {
  it('runs from 29 December into January', () => {
    for (const day of [
      '2026-12-29',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ]) {
      assert.equal(on(day), 'newyear', day);
    }
    assert.equal(on('2027-01-03'), undefined);
  });

  it('belongs to the year it started in, so its note is asked once', () => {
    const december = activeSeason(defaults, '2026-12-30');
    const january = activeSeason(defaults, '2027-01-02');
    assert.deepEqual(december, {
      id: 'newyear',
      start: '2026-12-29',
      end: '2027-01-02',
      key: 'newyear-2026',
    });
    assert.deepEqual(january, december);
  });

  it('works for any season an admin makes cross the year', () => {
    const calendar: SeasonCalendar = [
      { id: 'holidays', start: '11-20', end: '01-06' },
    ];
    assert.equal(on('2026-11-19', calendar), undefined);
    assert.equal(on('2026-11-20', calendar), 'holidays');
    assert.equal(on('2027-01-06', calendar), 'holidays');
    assert.equal(on('2027-01-07', calendar), undefined);
    assert.equal(activeSeason(calendar, '2027-01-06')?.key, 'holidays-2026');
  });

  it('is a single day when it starts and ends on the same one', () => {
    const calendar: SeasonCalendar = [
      { id: 'holidays', start: '12-24', end: '12-24' },
    ];
    assert.equal(on('2026-12-23', calendar), undefined);
    assert.equal(on('2026-12-24', calendar), 'holidays');
    assert.equal(on('2026-12-25', calendar), undefined);
  });

  it('copes with 29 February in years without one', () => {
    const calendar: SeasonCalendar = [
      { id: 'lunarnewyear', start: '02-20', end: '02-29' },
    ];
    assert.equal(on('2027-02-28', calendar), 'lunarnewyear');
    assert.equal(on('2027-03-01', calendar), undefined);
    assert.equal(on('2028-02-29', calendar), 'lunarnewyear');
    assert.deepEqual(seasonDates(calendar[0], 2027), {
      start: '2027-02-20',
      end: '2027-02-28',
    });
  });
});

describe('seasons that overlap', () => {
  it('show the one that started most recently', () => {
    // Holidays stretched to the 31st: New Year takes over on the 29th.
    const calendar: SeasonCalendar = [
      { id: 'holidays', start: '12-01', end: '12-31' },
      { id: 'newyear', start: '12-29', end: '01-02' },
    ];
    assert.equal(on('2026-12-28', calendar), 'holidays');
    assert.equal(on('2026-12-29', calendar), 'newyear');
    assert.equal(on('2027-01-01', calendar), 'newyear');
  });

  it('hand back to the one they interrupted when they end', () => {
    // Lunar New Year set by hand inside Halloween.
    const calendar: SeasonCalendar = [
      { id: 'halloween', start: '10-24', end: '11-01' },
      { id: 'lunarnewyear', start: '10-27', end: '10-31' },
    ];
    assert.equal(on('2027-10-26', calendar), 'halloween');
    assert.equal(on('2027-10-27', calendar), 'lunarnewyear');
    assert.equal(on('2027-10-31', calendar), 'lunarnewyear');
    assert.equal(on('2027-11-01', calendar), 'halloween');
  });

  it('go in the usual order when they start on the same day', () => {
    const calendar: SeasonCalendar = [
      { id: 'lunarnewyear', start: '06-01', end: '06-30' },
      { id: 'halloween', start: '06-01', end: '06-10' },
    ];
    assert.equal(on('2026-06-05', calendar), 'halloween');
  });
});

describe('Lunar New Year', () => {
  it('comes from a table of each year’s date, with its source', () => {
    assert.deepEqual(Object.keys(MOVING_SEASONS), ['lunarnewyear']);
    const moving = MOVING_SEASONS.lunarnewyear;
    assert.ok(moving.source.length > 20);
    for (const [year, day] of Object.entries(moving.days)) {
      assert.match(day, /^\d{2}-\d{2}$/, year);
    }
    assert.equal(moving.days[2027], '02-06');
    assert.equal(moving.days[2030], '02-03');
  });

  it('runs from New Year’s Eve to the Lantern Festival', () => {
    // 2026: New Year on 17 February.
    assert.deepEqual(seasonDates({ id: 'lunarnewyear' }, 2026), {
      start: '2026-02-16',
      end: '2026-03-03',
    });
    assert.equal(on('2026-02-15', everything), undefined);
    assert.equal(on('2026-02-16', everything), 'lunarnewyear');
    assert.equal(on('2026-03-03', everything), 'lunarnewyear');
    assert.equal(on('2026-03-04', everything), undefined);
    // 2028: New Year on 26 January, so its eve is in January too.
    assert.deepEqual(seasonDates({ id: 'lunarnewyear' }, 2028), {
      start: '2028-01-25',
      end: '2028-02-09',
    });
  });

  it('does nothing in a year the table does not reach', () => {
    assert.equal(seasonDates({ id: 'lunarnewyear' }, 2099), undefined);
    assert.equal(on('2099-02-10', everything), undefined);
  });

  it('uses dates an admin set instead, every year', () => {
    // The table's New Year in 2031 is 23 January.
    const calendar: SeasonCalendar = [
      { id: 'lunarnewyear', start: '02-01', end: '02-03' },
    ];
    assert.equal(on('2031-02-02', calendar), 'lunarnewyear');
    assert.equal(on('2031-01-23', calendar), undefined);
  });
});

describe('today, wherever the person is', () => {
  it('is the date on their own calendar', () => {
    // 03:00 in London on 24 October is still the 23rd in Los Angeles.
    const now = new Date('2026-10-24T02:00:00Z');
    assert.equal(localDay(now, 'Europe/London'), '2026-10-24');
    assert.equal(localDay(now, 'America/Los_Angeles'), '2026-10-23');
    assert.equal(localDay(now, 'Asia/Tokyo'), '2026-10-24');
    assert.equal(on(localDay(now, 'Europe/London')), 'halloween');
    assert.equal(on(localDay(now, 'America/Los_Angeles')), undefined);
  });

  it('ends New Year at midnight where they are, not elsewhere', () => {
    const now = new Date('2027-01-03T03:00:00Z');
    assert.equal(on(localDay(now, 'UTC')), undefined);
    assert.equal(on(localDay(now, 'America/New_York')), 'newyear');
    assert.equal(on(localDay(now, 'Pacific/Kiritimati')), undefined);
  });

  it('uses the server’s own clock for an unknown time zone', () => {
    const now = new Date('2026-10-24T12:00:00Z');
    assert.equal(localDay(now, 'Not/AZone'), localDay(now));
  });
});

describe('the season a person sees', () => {
  const today = '2026-10-30';

  it('is the one running, unless they switched seasons off', () => {
    assert.equal(
      shownSeason({ calendar: defaults, seasonal: true, today })?.id,
      'halloween'
    );
    assert.equal(
      shownSeason({ calendar: defaults, seasonal: false, today }),
      undefined
    );
  });

  it('is none when they turned this one off from its note', () => {
    assert.equal(
      shownSeason({
        calendar: defaults,
        seasonal: true,
        note: 'halloween-2026:off',
        today,
      }),
      undefined
    );
    assert.equal(
      shownSeason({
        calendar: defaults,
        seasonal: true,
        note: 'halloween-2026:keep',
        today,
      })?.id,
      'halloween'
    );
  });

  it('comes back the next time, after turning one off', () => {
    assert.equal(
      shownSeason({
        calendar: defaults,
        seasonal: true,
        note: 'halloween-2025:off',
        today,
      })?.id,
      'halloween'
    );
    assert.equal(
      shownSeason({
        calendar: defaults,
        seasonal: true,
        note: 'halloween-2026:off',
        today: '2026-12-05',
      })?.id,
      'holidays'
    );
  });

  it('is none when the server runs none', () => {
    assert.equal(
      shownSeason({ calendar: [], seasonal: true, today }),
      undefined
    );
  });
});

describe('what an admin can save', () => {
  it('is any of the seasons, switched on or off, with dates', () => {
    assert.deepEqual(
      cleanSeasons({
        halloween: { enabled: false, start: '10-01', end: '10-31' },
        lunarnewyear: { enabled: true, start: '02-01', end: '02-07' },
      }),
      {
        ...SEASON_DEFAULTS,
        halloween: { enabled: false, start: '10-01', end: '10-31' },
        lunarnewyear: { enabled: true, start: '02-01', end: '02-07' },
      }
    );
    assert.deepEqual(cleanSeasons({ lunarnewyear: { enabled: true } }), {
      ...SEASON_DEFAULTS,
      lunarnewyear: { enabled: true },
    });
  });

  it('refuses anything else', () => {
    for (const value of [
      null,
      [],
      'halloween',
      { easter: { enabled: true } },
      // Seasons there are no longer.
      { diwali: { enabled: true } },
      { pride: { enabled: false, start: '06-01', end: '06-30' } },
      { halloween: { enabled: 'yes', start: '10-24', end: '11-01' } },
      { halloween: { enabled: true } },
      { halloween: { enabled: true, start: '10-24' } },
      { halloween: { enabled: true, start: '13-01', end: '11-01' } },
      { halloween: { enabled: true, start: '02-30', end: '03-01' } },
      { halloween: { enabled: true, start: '10-24', end: '11-31' } },
      { halloween: { enabled: true, start: '1024', end: '11-01' } },
      { halloween: { enabled: true, start: '10-24', end: '11-01', x: 1 } },
      { lunarnewyear: { enabled: true, start: '02-01' } },
    ]) {
      assert.equal(cleanSeasons(value), undefined, JSON.stringify(value));
    }
  });

  it('is read back with the defaults for anything missing or broken', () => {
    assert.deepEqual(seasonSettings(undefined), SEASON_DEFAULTS);
    assert.deepEqual(
      seasonSettings({
        halloween: { enabled: false, start: '10-24', end: '11-01' },
        holidays: { enabled: true, start: 'soon' },
        easter: { enabled: true },
        diwali: { enabled: true },
        pride: { enabled: true, start: '06-01', end: '06-30' },
      }),
      {
        ...SEASON_DEFAULTS,
        halloween: { enabled: false, start: '10-24', end: '11-01' },
      }
    );
  });
});

describe('the answer to a season’s note', () => {
  it('is one season, the year it started, and keep or off', () => {
    assert.equal(cleanSeasonNote('halloween-2026:keep'), 'halloween-2026:keep');
    assert.equal(cleanSeasonNote('newyear-2026:off'), 'newyear-2026:off');
    for (const value of [
      'halloween-2026',
      'halloween:off',
      'easter-2026:off',
      'diwali-2026:off',
      'pride-2026:keep',
      'halloween-26:off',
      'halloween-2026:maybe',
      ' halloween-2026:off',
      42,
      null,
    ]) {
      assert.equal(cleanSeasonNote(value), undefined, String(value));
    }
  });
});

describe('the dates shown for a season', () => {
  it('are the ones running now, or the next ones', () => {
    assert.deepEqual(upcomingDates(defaults[0], '2026-10-30'), {
      start: '2026-10-24',
      end: '2026-11-01',
    });
    assert.deepEqual(upcomingDates(defaults[0], '2026-11-02'), {
      start: '2027-10-24',
      end: '2027-11-01',
    });
    assert.deepEqual(upcomingDates(defaults[2], '2027-01-01'), {
      start: '2026-12-29',
      end: '2027-01-02',
    });
    assert.deepEqual(upcomingDates({ id: 'lunarnewyear' }, '2026-03-04'), {
      start: '2027-02-05',
      end: '2027-02-20',
    });
    assert.equal(
      upcomingDates({ id: 'lunarnewyear' }, '2098-12-01'),
      undefined
    );
  });
});

/*
 * Diwali and Pride Month were seasons once. A settings file or an answer
 * to a note saved then still reads, as if they had never been there.
 */
describe('a server that ran Diwali or Pride Month', () => {
  const stored = {
    halloween: { enabled: true, start: '10-24', end: '11-01' },
    holidays: { enabled: true, start: '12-01', end: '12-28' },
    newyear: { enabled: true, start: '12-29', end: '01-02' },
    lunarnewyear: { enabled: true },
    diwali: { enabled: true },
    pride: { enabled: true, start: '06-01', end: '06-30' },
  };
  const calendar = seasonCalendar(seasonSettings(stored));

  it('runs the other seasons as they were set', () => {
    assert.deepEqual(seasonSettings(stored), {
      ...SEASON_DEFAULTS,
      lunarnewyear: { enabled: true },
    });
    assert.deepEqual(
      calendar.map((season) => season.id),
      ['halloween', 'holidays', 'newyear', 'lunarnewyear']
    );
  });

  it('shows everyone their own look on what were their days', () => {
    // Diwali 2026 was 6 to 10 November; Pride Month all of June.
    for (const today of ['2026-11-08', '2026-06-15']) {
      assert.equal(activeSeason(calendar, today), undefined, today);
      for (const note of [null, 'diwali-2026:keep', 'pride-2026:off']) {
        assert.equal(
          shownSeason({ calendar, seasonal: true, note, today }),
          undefined,
          `${today} ${note}`
        );
      }
    }
    // Diwali 2027 fell inside Halloween, which now runs all the way.
    assert.equal(activeSeason(calendar, '2027-10-28')?.id, 'halloween');
  });

  it('asks about the next season as usual after an old answer', () => {
    for (const note of ['diwali-2026:off', 'pride-2026:off']) {
      assert.equal(
        shownSeason({ calendar, seasonal: true, note, today: '2026-12-05' })
          ?.id,
        'holidays',
        note
      );
    }
  });
});
