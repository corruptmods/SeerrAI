/*
 * The choices offered when editing a job's schedule, and the schedule each
 * one saves (with seconds first, as the server's scheduler reads it).
 *
 * A cron step only repeats evenly when it divides its field: "every 18 hours"
 * written as a step ran at midnight and 6pm, six hours apart, and "every 3
 * days" restarted on the 1st of each month. So only choices that really
 * repeat that often are offered. A week is a day of the week, not a step.
 */

export type ScheduleInterval = 'seconds' | 'minutes' | 'hours' | 'days';

export const SCHEDULE_CHOICES: Record<ScheduleInterval, number[]> = {
  seconds: [10, 15, 20, 30, 60],
  minutes: [1, 2, 3, 5, 10, 15, 20, 30, 60],
  hours: [1, 2, 3, 4, 6, 8, 12, 24],
  days: [1, 7],
};

/** The schedule for running a job every `every` of `interval`. */
export const scheduleFor = (
  interval: ScheduleInterval,
  every: number
): string => {
  if (!SCHEDULE_CHOICES[interval].includes(every)) {
    throw new Error(`Every ${every} ${interval} is not offered.`);
  }
  switch (interval) {
    case 'seconds':
      return every === 60 ? '0 * * * * *' : `*/${every} * * * * *`;
    case 'minutes':
      return every === 60 ? '0 0 * * * *' : `0 */${every} * * * *`;
    case 'hours':
      return every === 24 ? '0 0 0 * * *' : `0 0 */${every} * * *`;
    case 'days':
      // At 1am, every day or every Sunday.
      return every === 7 ? '0 0 1 * * 0' : '0 0 1 * * *';
  }
};

/**
 * Which choice a saved schedule is, so the editor opens on it rather than on
 * a default that saving would quietly put in its place. Undefined for a
 * schedule none of the choices make (an older one, or one set by hand).
 */
export const choiceFor = (
  interval: ScheduleInterval,
  schedule: string
): number | undefined =>
  SCHEDULE_CHOICES[interval].find(
    (every) => scheduleFor(interval, every) === schedule
  );
