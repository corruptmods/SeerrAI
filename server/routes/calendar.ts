import { getCalendar } from '@server/lib/calendar';
import { featureEnabled } from '@server/lib/features';
import { Router } from 'express';

const calendarRoutes = Router();

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What is coming over the next few weeks. Starts a day early: a film's
 * release sits at midnight UTC, which west of UTC is still the day before,
 * so today's releases would otherwise be missed. The page shows from the
 * viewer's own today.
 */
calendarRoutes.get('/', async (req, res, next) => {
  const weeks = Math.min(12, Math.max(1, Number(req.query.weeks) || 4));
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const start = new Date(today.getTime() - DAY_MS);
  const end = new Date(today.getTime() + (weeks * 7 + 1) * DAY_MS);

  try {
    return res.status(200).json({
      start: start.toISOString(),
      end: end.toISOString(),
      items: featureEnabled('releaseCalendar', req.user)
        ? await getCalendar(start, end)
        : [],
    });
  } catch (e) {
    return next({ status: 500, message: e.message });
  }
});

export default calendarRoutes;
