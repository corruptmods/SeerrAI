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
 * The look on screen. The server writes it (pages/_document); this keeps it
 * in sync with the user's choice and server default, supports Appearance
 * page previews, and layers any running season on top.
 */

interface ThemeContextValue {
  /** The look on screen, including a preview. */
  appearance: Appearance;
  /** Previews a look without saving; null restores the chosen one. */
  setPreview: (appearance: Appearance | null) => void;
  /** The season on screen, including a preview. */
  season?: SeasonId;
  /** The server's season today, shown or not. */
  current?: ActiveSeason;
  /** Today on this device, 'YYYY-MM-DD'. */
  today: string;
  /** Previews a season over the previewed look (Appearance page only); null for none. */
  setSeasonPreview: (season: SeasonId | null) => void;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

/** Ms until one second past local midnight. */
const untilTomorrow = (now: Date): number =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() -
  now.getTime() +
  1000;

export const ThemeProvider = ({
  deviceAppearance,
  seasonDay,
  children,
}: {
  /** The device's copy, for pages before sign-in. */
  deviceAppearance?: Appearance;
  /**
   * The server's date at first, so the page starts as sent; then the
   * device's, kept current so a season ends on a page left open.
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
    // Timers run late on a device that slept past midnight.
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
  // During a preview, only an explicitly previewed season shows.
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

  // Compare as text: a refetched user is an equal but new object.
  const shown = JSON.stringify(appearance);
  const signedIn = !!user;
  const hasOwn = !!own;
  useEffect(() => {
    // Previews are never stored. The user's own look is copied to the device
    // for the sign-in page; the server default clears it. The season is never
    // stored. Safe mode drops theme files but keeps the built-in season.
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

/** The look on screen, and preview controls. */
export const useTheme = (): ThemeContextValue => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme is used outside ThemeProvider');
  }
  return context;
};

/** The device's stored look: from request cookies on the server, document cookies in the browser. */
export const deviceAppearanceFrom = (
  cookieHeader: string | undefined
): Appearance | undefined =>
  appearanceFromCookie(
    typeof document === 'undefined' ? cookieHeader : document.cookie
  );
