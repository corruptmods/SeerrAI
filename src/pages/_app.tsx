import { dismissBootScreen } from '@app/components/BootScreen';
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
import type { User } from '@app/hooks/useUser';
import { Permission, useUser } from '@app/hooks/useUser';
import '@app/styles/globals.css';
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
 * A locale's messages. A JSON import is a module: its strings are both its
 * named exports and its `default`, so passing the module on would put every
 * string in the page twice. Only the strings are wanted.
 */
const loadLocaleData = async (
  locale: AvailableLocale
): Promise<Record<string, string>> => {
  const imported = await importLocale(locale);
  return imported.default ?? imported;
};

// Custom types so we can correctly type our GetInitialProps function
// with our combined user prop
// This is specific to _app.tsx. Other pages will not need to do this!
type NextAppComponentType = typeof App;
type MessagesType = Record<string, string>;

interface ExtendedAppProps extends AppProps {
  user: User;
  messages: MessagesType;
  locale: AvailableLocale;
  currentSettings: PublicSettingsResponse;
  /** The look kept on this device, for pages before anyone signs in. */
  deviceAppearance?: Appearance;
  /** The day the page is made for, for seasonal themes. */
  seasonDay?: string;
}

// Every API request carries the build this page is running, so the server
// can recognise a client stranded on an old build (see /api/v1/status).
axios.defaults.headers.common['X-Seerr-Build'] =
  process.env.commitTag ?? 'local';

const CoreApp: Omit<NextAppComponentType, 'origGetInitialProps'> = ({
  Component,
  pageProps,
  router,
  user,
  messages,
  locale,
  currentSettings,
  deviceAppearance,
  seasonDay,
}: ExtendedAppProps) => {
  let component: React.ReactNode;
  const [loadedMessages, setMessages] = useState<MessagesType>(messages);
  const [currentLocale, setLocale] = useState<AvailableLocale>(locale);

  // The app is up: fade out the startup screen shown by the installed app.
  useEffect(() => dismissBootScreen(), []);

  // The page arrives with the strings for its locale already in it; load
  // others only when the locale actually changes. Loading them again on
  // every start meant downloading and parsing them a second time and then
  // re-rendering the whole app with an identical copy.
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
  // A yes or no, not the function: that is new on every render, and as a
  // dependency it re-ran the effect below, and its request, each time.
  const isAdmin = hasPermission(Permission.ADMIN);

  useEffect(() => {
    const requestsCount = async () => {
      const response = await axios.get('/api/v1/request/count');
      return response.data;
    };

    // Cast navigator to a type that includes setAppBadge and clearAppBadge
    // to avoid TypeScript errors while ensuring these methods exist before calling them.
    const newNavigator = navigator as unknown as {
      setAppBadge?: (count: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };

    const handleBadgeUpdate = () => {
      if ('setAppBadge' in newNavigator) {
        // The badge is a nicety: a failed count or a refused badge is
        // left alone rather than surfacing as an unhandled error.
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
        // Switching back to an installed web app fires a focus event, and by
        // default every mounted hook refetches on it — the home page alone
        // is 20+ requests. Throttle so a focus refetches at most once a
        // minute; navigating still refetches on mount, and anything
        // time-sensitive (download progress) has its own polling.
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
    // Both loopback calls are independent — the user lookup only needs the
    // settings for the redirect decision afterwards, not for the request
    // itself — so run them together. On a cold launch this is on the critical
    // path before anything paints, and the user lookup crosses to the
    // database host.
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

    // Who this page was rendered for. The service worker compares it with
    // whose Discover rows it is holding, so a sign-in it never saw (on a
    // page it did not control) still cannot show one person another's.
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
        // Already signed in: on to the page sign-in was asked to return to,
        // if there is one.
        ctx.res.writeHead(307, {
          Location:
            router.pathname === '/login'
              ? safeRedirect(ctx.query.redirect)
              : '/',
        });
        ctx.res.end();
      }
    } else if (!router.pathname.match(/(login|setup|resetpassword)/)) {
      // No user and not already on an auth route: redirect to /login with a
      // 307 before anything actually renders, remembering the page asked for
      // so signing in comes back to it.
      ctx.res.writeHead(307, {
        Location: loginUrl(ctx.asPath),
      });
      ctx.res.end();
    }
  }

  // Run the default getInitialProps for the main nextjs initialProps
  const appInitialProps: AppInitialProps =
    await App.getInitialProps(initialProps);

  const locale = user?.settings?.locale
    ? user.settings.locale
    : currentSettings.locale;

  // The polyfill check does not depend on which locale is chosen.
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
