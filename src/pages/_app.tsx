import Layout from '@app/components/Layout';
import LoadingBar from '@app/components/LoadingBar';
import PWAHeader, { ThemeColour } from '@app/components/PWAHeader';
import ServiceWorkerSetup from '@app/components/ServiceWorkerSetup';
import StatusChecker from '@app/components/StatusChecker';
import CustomCss from '@app/components/Themes/CustomCss';
import { InteractionProvider } from '@app/context/InteractionContext';
import { LanguageContext } from '@app/context/LanguageContext';
import { NoticeQueueProvider } from '@app/context/NoticeQueue';
import { SettingsProvider } from '@app/context/SettingsContext';
import { deviceAppearanceFrom, ThemeProvider } from '@app/context/ThemeContext';
import { UserContext } from '@app/context/UserContext';
import { PushDeviceProvider } from '@app/hooks/usePushDeviceState';
import useResumePage from '@app/hooks/useResumePage';
import type { User } from '@app/hooks/useUser';
import { Permission, useUser } from '@app/hooks/useUser';
import '@app/styles/globals.css';
import { retryWithFreshCsrfToken } from '@app/utils/csrfRetry';
import { loginUrl, safeRedirect } from '@app/utils/loginRedirect';
import { polyfillIntl } from '@app/utils/polyfillIntl';
import { getHostAndPort } from '@app/utils/urlHelper';
import '@fontsource-variable/inter';
import { MediaServerType } from '@server/constants/server';
import type { Appearance } from '@server/constants/theme';
import { SERVER_THEME_DEFAULTS } from '@server/constants/theme';
import type { PublicSettingsResponse } from '@server/interfaces/api/settingsInterfaces';
import { localDay } from '@server/lib/seasons';
import type { AvailableLocale } from '@server/types/languages';
import axios from 'axios';
import type { AppInitialProps, AppProps } from 'next/app';
import App from 'next/app';
import Head from 'next/head';
import { useEffect, useRef, useState } from 'react';
import { Toaster } from 'react-hot-toast';
import { IntlProvider } from 'react-intl';
import { SWRConfig } from 'swr';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const importLocale = (locale: AvailableLocale): Promise<any> => {
  switch (locale) {
    case 'ar':
      return import('../i18n/locale/ar.json');
    case 'bg':
      return import('../i18n/locale/bg.json');
    case 'ca':
      return import('../i18n/locale/ca.json');
    case 'cs':
      return import('../i18n/locale/cs.json');
    case 'da':
      return import('../i18n/locale/da.json');
    case 'de':
      return import('../i18n/locale/de.json');
    case 'el':
      return import('../i18n/locale/el.json');
    case 'es':
      return import('../i18n/locale/es.json');
    case 'es-MX':
      return import('../i18n/locale/es_MX.json');
    case 'et':
      return import('../i18n/locale/et.json');
    case 'eu':
      return import('../i18n/locale/eu.json');
    case 'fi':
      return import('../i18n/locale/fi.json');
    case 'fr':
      return import('../i18n/locale/fr.json');
    case 'he':
      return import('../i18n/locale/he.json');
    case 'hi':
      return import('../i18n/locale/hi.json');
    case 'hr':
      return import('../i18n/locale/hr.json');
    case 'hu':
      return import('../i18n/locale/hu.json');
    case 'it':
      return import('../i18n/locale/it.json');
    case 'ja':
      return import('../i18n/locale/ja.json');
    case 'kab':
      return import('../i18n/locale/kab.json');
    case 'ko':
      return import('../i18n/locale/ko.json');
    case 'lb':
      return import('../i18n/locale/lb.json');
    case 'lt':
      return import('../i18n/locale/lt.json');
    case 'nb-NO':
      return import('../i18n/locale/nb_NO.json');
    case 'nl':
      return import('../i18n/locale/nl.json');
    case 'pl':
      return import('../i18n/locale/pl.json');
    case 'pt-BR':
      return import('../i18n/locale/pt_BR.json');
    case 'pt-PT':
      return import('../i18n/locale/pt_PT.json');
    case 'ro':
      return import('../i18n/locale/ro.json');
    case 'ru':
      return import('../i18n/locale/ru.json');
    case 'sk':
      return import('../i18n/locale/sk.json');
    case 'sl':
      return import('../i18n/locale/sl.json');
    case 'sq':
      return import('../i18n/locale/sq.json');
    case 'sr':
      return import('../i18n/locale/sr.json');
    case 'sv':
      return import('../i18n/locale/sv.json');
    case 'tr':
      return import('../i18n/locale/tr.json');
    case 'uk':
      return import('../i18n/locale/uk.json');
    case 'vi':
      return import('../i18n/locale/vi.json');
    case 'zh-CN':
      return import('../i18n/locale/zh_Hans.json');
    case 'zh-TW':
      return import('../i18n/locale/zh_Hant.json');
    default:
      return import('../i18n/locale/en.json');
  }
};

/**
 * A locale's messages. Returns only `default`: the JSON module also exposes
 * each string as a named export, which would double them in the page.
 */
const loadLocaleData = async (
  locale: AvailableLocale
): Promise<Record<string, string>> => {
  const imported = await importLocale(locale);
  return imported.default ?? imported;
};

/**
 * The first page's strings in the browser, loaded before start. Fetched as a
 * cached build file rather than inlined in every page (about 400 KB). English
 * if they fail to load.
 */
const startStrings: MessagesType | undefined =
  typeof window === 'undefined'
    ? undefined
    : await loadLocaleData(
        (window.__NEXT_DATA__?.props?.locale as AvailableLocale) ?? 'en'
      ).catch(() => undefined);

// Types getInitialProps with the combined user prop. Only _app needs this.
type NextAppComponentType = typeof App;
type MessagesType = Record<string, string>;

/** Props the server sends with the first page of a visit. */
interface FirstPageProps {
  user?: User;
  /**
   * Strings for the server render only; _document strips them from the page
   * and the browser loads them as a file (startStrings).
   */
  messages?: MessagesType;
  locale: AvailableLocale;
  currentSettings: PublicSettingsResponse;
  /** This device's appearance, for pages before sign-in. */
  deviceAppearance?: Appearance;
  /** The page's date, for seasonal themes. */
  seasonDay?: string;
}

/**
 * Client-side navigations bring only page props (see getInitialProps); the
 * app keeps what its first page gave it.
 */
type ExtendedAppProps = AppProps & Partial<FirstPageProps>;

// Lets the server spot clients stranded on an old build (see /api/v1/status).
axios.defaults.headers.common['X-Seerr-Build'] =
  process.env.commitTag ?? 'local';
if (typeof window !== 'undefined') {
  // Per tab, so one tab's music search never cancels another's.
  axios.defaults.headers.common['X-Seerr-Tab'] = Math.random()
    .toString(36)
    .slice(2, 12);
  retryWithFreshCsrfToken(axios);
  void polyfillIntl();
}

const CoreApp: Omit<NextAppComponentType, 'origGetInitialProps'> = ({
  Component,
  pageProps,
  router,
  ...given
}: ExtendedAppProps) => {
  // Fixed for the visit; user and settings are only starting values, kept
  // fresh by the app afterwards.
  const [firstPage] = useState(given as FirstPageProps);
  const {
    user,
    messages,
    locale,
    currentSettings,
    deviceAppearance,
    seasonDay,
  } = firstPage;
  let component: React.ReactNode;
  const [loadedMessages, setMessages] = useState<MessagesType>(
    messages ?? startStrings ?? {}
  );
  const [currentLocale, setLocale] = useState<AvailableLocale>(locale);

  // Restore the page iOS was on if it restarted the installed app.
  useResumePage(router);

  // The page already has its locale's strings; load only on a real change,
  // or every start re-downloads them and re-renders the app.
  const loadedLocale = useRef(locale);
  useEffect(() => {
    if (currentLocale === loadedLocale.current) {
      return;
    }
    let cancelled = false;
    loadLocaleData(currentLocale).then((next) => {
      if (!cancelled) {
        loadedLocale.current = currentLocale;
        setMessages(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [currentLocale]);

  const { hasPermission } = useUser();
  // A boolean, not the function, which is new each render and would re-run
  // the effect below.
  const isAdmin = hasPermission(Permission.ADMIN);

  useEffect(() => {
    const requestsCount = async () => {
      const response = await axios.get('/api/v1/request/count');
      return response.data;
    };

    // The badge methods aren't in the DOM typings.
    const newNavigator = navigator as unknown as {
      setAppBadge?: (count: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };

    const handleBadgeUpdate = () => {
      if ('setAppBadge' in newNavigator) {
        // Badge failures are ignored rather than surfacing as unhandled errors.
        if (!router.pathname.match(/(login|setup|resetpassword)/) && isAdmin) {
          requestsCount()
            .then((data) =>
              data.pending > 0
                ? newNavigator.setAppBadge?.(data.pending)
                : newNavigator.clearAppBadge?.()
            )
            .catch(() => undefined);
        } else {
          newNavigator.clearAppBadge?.()?.catch(() => undefined);
        }
      }
    };

    handleBadgeUpdate();

    window.addEventListener('focus', handleBadgeUpdate);

    return () => {
      window.removeEventListener('focus', handleBadgeUpdate);
    };
  }, [isAdmin, router.pathname]);

  if (router.pathname.match(/(login|setup|resetpassword)/)) {
    component = <Component {...pageProps} />;
  } else {
    component = (
      <Layout>
        <Component {...pageProps} />
      </Layout>
    );
  }

  return (
    <SWRConfig
      value={{
        fetcher: (url) => axios.get(url).then((res) => res.data),
        // Returning to the installed app fires focus, which refetches every
        // mounted hook (20+ on home). At most once a minute; time-sensitive
        // data has its own polling.
        focusThrottleInterval: 60000,
        dedupingInterval: 5000,
        fallback: {
          '/api/v1/auth/me': user,
        },
      }}
    >
      <LanguageContext.Provider value={{ locale: currentLocale, setLocale }}>
        <IntlProvider
          locale={currentLocale}
          defaultLocale="en"
          messages={loadedMessages}
        >
          <LoadingBar />
          <SettingsProvider currentSettings={currentSettings}>
            <ThemeProvider
              deviceAppearance={deviceAppearance}
              seasonDay={seasonDay}
            >
              <InteractionProvider>
                <Head>
                  <title>{currentSettings.applicationTitle}</title>
                  <meta
                    name="viewport"
                    content="initial-scale=1, viewport-fit=cover, width=device-width"
                  />
                  <meta name="apple-mobile-web-app-capable" content="yes" />
                  <meta
                    name="apple-mobile-web-app-status-bar-style"
                    content="black-translucent"
                  />
                  <PWAHeader
                    applicationTitle={currentSettings.applicationTitle}
                  />
                </Head>
                <ThemeColour />
                <CustomCss />
                <NoticeQueueProvider>
                  <StatusChecker />
                  <ServiceWorkerSetup />
                  <UserContext initialUser={user}>
                    <PushDeviceProvider>{component}</PushDeviceProvider>
                  </UserContext>
                </NoticeQueueProvider>
                <Toaster
                  position="top-right"
                  toastOptions={{ duration: 4000 }}
                  containerStyle={{
                    zIndex: 10000,
                    top: 'calc(env(safe-area-inset-top) + 0.75rem)',
                  }}
                />
              </InteractionProvider>
            </ThemeProvider>
          </SettingsProvider>
        </IntlProvider>
      </LanguageContext.Provider>
    </SWRConfig>
  );
};

CoreApp.getInitialProps = async (initialProps) => {
  // Client-side navigation: the app already has its first page's props (see
  // CoreApp). Rebuilding them here would hand it a signed-out, unconfigured
  // copy while its checks are in flight.
  if (typeof window !== 'undefined') {
    return App.getInitialProps(initialProps);
  }

  const { ctx, router } = initialProps;
  let user: User | undefined = undefined;
  let currentSettings: PublicSettingsResponse = {
    initialized: false,
    applicationTitle: '',
    applicationUrl: '',
    disabledFeatures: [],
    animeExcludedCountries: [],
    hideAvailable: false,
    hideBlocklisted: false,
    hideRequested: false,
    movie4kEnabled: false,
    series4kEnabled: false,
    localLogin: true,
    mediaServerLogin: true,
    personalApiKeys: 'off',
    mediaServers: [],
    oidcProviders: [],
    discoverRegion: '',
    streamingRegion: '',
    originalLanguage: '',
    mediaServerType: MediaServerType.NOT_CONFIGURED,
    partialRequestsEnabled: true,
    enableSpecialEpisodes: false,
    cacheImages: false,
    vapidPublic: '',
    enablePushRegistration: false,
    locale: 'en',
    emailEnabled: false,
    newPlexLogin: true,
    youtubeUrl: '',
    versionCheck: true,
    plexClientIdentifier: '',
    aiReady: false,
    subtitlesReady: false,
    traktReady: false,
    musicReady: false,
    musicSearch: { inAll: false },
    musicSongs: false,
    themeDefault: SERVER_THEME_DEFAULTS,
    seasons: [],
    customCss: { server: null, personal: false },
  };

  if (ctx.res) {
    // Independent loopback calls, run together: this is on the cold-launch
    // critical path and the user lookup hits the database host.
    const cookieHeaders =
      ctx.req && ctx.req.headers.cookie
        ? { cookie: ctx.req.headers.cookie }
        : undefined;

    const [settingsResponse, userResponse] = await Promise.all([
      axios.get<PublicSettingsResponse>(
        `http://${getHostAndPort()}/api/v1/settings/public`
      ),
      axios
        .get<User>(`http://${getHostAndPort()}/api/v1/auth/me`, {
          headers: cookieHeaders,
        })
        .catch(() => null),
    ]);

    currentSettings = settingsResponse.data;

    // The service worker compares this with the owner of its cached Discover
    // rows, so an unseen sign-in can't show one user another's rows.
    ctx.res.setHeader('X-Seerr-User', String(userResponse?.data?.id ?? 0));

    const initialized = settingsResponse.data.initialized;

    if (!initialized) {
      if (!router.pathname.match(/(setup|login\/plex)/)) {
        ctx.res.writeHead(307, {
          Location: '/setup',
        });
        ctx.res.end();
      }
    } else if (userResponse) {
      user = userResponse.data;

      if (router.pathname.match(/(setup|login)/)) {
        // Already signed in: go to the requested return page, if any.
        ctx.res.writeHead(307, {
          Location:
            router.pathname === '/login'
              ? safeRedirect(ctx.query.redirect)
              : '/',
        });
        ctx.res.end();
      }
    } else if (!router.pathname.match(/(login|setup|resetpassword)/)) {
      // Not signed in: 307 to /login before rendering, keeping the return page.
      ctx.res.writeHead(307, {
        Location: loginUrl(ctx.asPath),
      });
      ctx.res.end();
    }
  }

  const appInitialProps: AppInitialProps =
    await App.getInitialProps(initialProps);

  const locale = user?.settings?.locale
    ? user.settings.locale
    : currentSettings.locale;

  // The polyfill check doesn't depend on the locale.
  const [messages] = await Promise.all([
    loadLocaleData(locale as AvailableLocale),
    polyfillIntl(),
  ]);

  return {
    ...appInitialProps,
    user,
    messages,
    locale,
    currentSettings,
    deviceAppearance: deviceAppearanceFrom(ctx.req?.headers.cookie),
    seasonDay: localDay(new Date()),
  };
};

export default CoreApp;
