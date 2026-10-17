import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import { applyAppearance, chosenAppearance } from '@app/utils/theme';
import { isSafeMode } from '@app/utils/theme/safeMode';
import type { Appearance } from '@server/constants/theme';
import { appearanceFromCookie } from '@server/constants/theme';
import { withoutThemeFile } from '@server/constants/themeFile';
import type { ActiveSeason, SeasonId } from '@server/lib/seasons';
import { activeSeason, localDay, shownSeason } from '@server/lib/seasons';
import React, { useContext, useEffect, useMemo, useState } from 'react';

/*
 * The look on screen. The server writes it into the page (pages/_document);
 * from then on this keeps it in step with the signed-in person's choice
 * and the server's default, and lets the Appearance page show a look
 * before it is saved. A seasonal theme, while one runs, sits on top.
 */

interface ThemeContextValue {
  /** The look on screen now, a preview included. */
  appearance: Appearance;
  /** Shows a look without keeping it; null goes back to the chosen one. */
  setPreview: (appearance: Appearance | null) => void;
  /** The seasonal theme on screen now, a preview included. */
  season?: SeasonId;
  /** The season this server is running today, whether shown or not. */
  current?: ActiveSeason;
  /** Today on this device's calendar, 'YYYY-MM-DD'. */
  today: string;
  /**
   * Shows a season on top of the look being previewed; null for none. Only
   * while a look is previewed (the Appearance page).
   */
  setSeasonPreview: (season: SeasonId | null) => void;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

/** How long until the next day starts on this device, and a second over. */
const untilTomorrow = (now: Date): number =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() -
  now.getTime() +
  1000;

export const ThemeProvider = ({
  deviceAppearance,
  seasonDay,
  children,
}: {
  /** The copy kept on this device, for pages before anyone signs in. */
  deviceAppearance?: Appearance;
  /**
   * The day the page was made for. The server's day at first, so the page
   * starts as it was sent; then this device's own, kept up to date so a
   * season ends by itself on a page left open.
   */
  seasonDay?: string;
  children: React.ReactNode;
}) => {
  const { user } = useUser();
  const { currentSettings } = useSettings();
  const [preview, setPreview] = useState<Appearance | null>(null);
  const [seasonPreview, setSeasonPreview] = useState<SeasonId | null>(null);
  const [today, setToday] = useState(() => seasonDay ?? localDay(new Date()));
  const own = user?.settings?.appearance;
  const note = user?.settings?.seasonNote;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      clearTimeout(timer);
      const now = new Date();
      setToday(localDay(now));
      timer = setTimeout(check, untilTomorrow(now));
    };
    check();
    // A device that slept past midnight runs its timers late.
    document.addEventListener('visibilitychange', check);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);

  const chosen = useMemo(
    () =>
      chosenAppearance({
        signedIn: !!user,
        own,
        device: deviceAppearance,
        server: currentSettings.themeDefault,
      }),
    [user, own, deviceAppearance, currentSettings.themeDefault]
  );
  const appearance = preview ?? chosen;

  const calendar = currentSettings.seasons;
  const current = useMemo(
    () => activeSeason(calendar ?? [], today),
    [calendar, today]
  );
  // While a look is previewed, only a season asked for is shown on top, so
  // the look itself can be seen.
  const season = preview
    ? (seasonPreview ?? undefined)
    : shownSeason({
        calendar: calendar ?? [],
        seasonal: chosen.seasonal,
        note,
        today,
      })?.id;
  useEffect(() => {
    if (!preview) {
      setSeasonPreview(null);
    }
  }, [preview]);

  // Compared as text: a refetched user brings an equal but new object.
  const shown = JSON.stringify(appearance);
  const signedIn = !!user;
  const hasOwn = !!own;
  useEffect(() => {
    // A preview is never kept. A signed-in person's own look is copied to
    // the device for the sign-in page; using the server's default clears
    // the copy. The season is never part of the copy. Safe mode shows
    // every look without its theme file, but keeps the season: seasons
    // are built in.
    const look = JSON.parse(shown) as Appearance;
    applyAppearance(
      isSafeMode() ? withoutThemeFile(look) : look,
      preview || !signedIn ? undefined : hasOwn ? 'remember' : 'forget',
      season
    );
  }, [shown, preview, signedIn, hasOwn, season]);

  const value = useMemo(
    () => ({
      appearance,
      setPreview,
      season,
      current,
      today,
      setSeasonPreview,
    }),
    [appearance, season, current, today]
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
};

/** The look on screen, and a way to preview another. */
export const useTheme = (): ThemeContextValue => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme is used outside ThemeProvider');
  }
  return context;
};

/**
 * The copy of a look kept on this device: from the request on the server,
 * from the page's cookies in the browser.
 */
export const deviceAppearanceFrom = (
  cookieHeader: string | undefined
): Appearance | undefined =>
  appearanceFromCookie(
    typeof document === 'undefined' ? cookieHeader : document.cookie
  );
