import AiChat from '@app/components/AiChat';
import MobileMenu from '@app/components/Layout/MobileMenu';
import PullToRefresh from '@app/components/Layout/PullToRefresh';
import SearchInput from '@app/components/Layout/SearchInput';
import Sidebar from '@app/components/Layout/Sidebar';
import UserDropdown from '@app/components/Layout/UserDropdown';
import UserWarnings from '@app/components/Layout/UserWarnings';
import WatchSuggestions from '@app/components/MediaLists/WatchSuggestions';
import PasskeyNudge from '@app/components/PasskeyNudge';
import PushOptInBanner from '@app/components/PushOptIn/PushOptInBanner';
import SeasonalNote from '@app/components/Seasonal/SeasonalNote';
import { NavLayoutProvider } from '@app/context/NavLayoutContext';
import useLocale from '@app/hooks/useLocale';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { ArrowLeftIcon, Bars3BottomLeftIcon } from '@heroicons/react/24/solid';
import type { AvailableLocale } from '@server/types/languages';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Layout', {
  openSidebar: 'Open sidebar',
  goBack: 'Go back',
});

type LayoutProps = {
  children: React.ReactNode;
};

const Layout = ({ children }: LayoutProps) => {
  const [isSidebarOpen, setSidebarOpen] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const intl = useIntl();
  const { user } = useUser();
  const router = useRouter();
  const { currentSettings } = useSettings();
  const { setLocale } = useLocale();
  const { data: requestResponse, mutate: revalidateRequestsCount } = useSWR(
    '/api/v1/request/count',
    {
      revalidateOnMount: true,
    }
  );
  const { data: issueResponse, mutate: revalidateIssueCount } = useSWR(
    '/api/v1/issue/count',
    {
      revalidateOnMount: true,
    }
  );

  useEffect(() => {
    if (setLocale && user) {
      setLocale(
        (user?.settings?.locale
          ? user.settings.locale
          : currentSettings.locale) as AvailableLocale
      );
    }
  }, [setLocale, currentSettings.locale, user]);

  useEffect(() => {
    const updateScrolled = () => {
      if (window.pageYOffset > 20) {
        setIsScrolled(true);
      } else {
        setIsScrolled(false);
      }
    };

    window.addEventListener('scroll', updateScrolled, { passive: true });

    return () => {
      window.removeEventListener('scroll', updateScrolled);
    };
  }, []);

  // How far into this visit's history the current page is, so the back
  // button knows whether there is anywhere to go. A reload — an update
  // prompt, or the app being restored by iOS — wipes the history stack, and
  // router.back() on an empty stack does nothing at all, which reads as a
  // dead button.
  //
  // Each history entry Next makes carries a key: a push makes a new one, a
  // replace (a filter changing the address, say) keeps it. So an entry seen
  // before is a step back or forward to a known depth, and a new one is one
  // deeper. Counting route changes instead counted replaces, and the back
  // step itself, as further pages, until the button walked out of the app.
  const depthByEntry = useRef(new Map<string, number>());
  const historyDepth = useRef(0);

  useEffect(() => {
    const entryKey = (): string | undefined =>
      (window.history.state as { key?: string } | null)?.key;

    // The entry being left. Next only labels the first entry once the app
    // has started, so it is recorded on the way out rather than on load.
    const onRouteStart = () => {
      const key = entryKey();
      if (key && !depthByEntry.current.has(key)) {
        depthByEntry.current.set(key, historyDepth.current);
      }
    };

    const onRouteChange = () => {
      const key = entryKey();
      if (!key) {
        return;
      }
      const known = depthByEntry.current.get(key);
      if (known !== undefined) {
        historyDepth.current = known;
        return;
      }
      historyDepth.current += 1;
      depthByEntry.current.set(key, historyDepth.current);
    };

    router.events.on('routeChangeStart', onRouteStart);
    router.events.on('routeChangeComplete', onRouteChange);

    return () => {
      router.events.off('routeChangeStart', onRouteStart);
      router.events.off('routeChangeComplete', onRouteChange);
    };
  }, [router.events]);

  const goBack = useCallback(() => {
    if (historyDepth.current > 0) {
      router.back();
      return;
    }

    // Nothing to return to: fall back to the listing the current page most
    // likely came from, rather than leaving the button inert.
    if (router.pathname.startsWith('/movie')) {
      router.push('/discover/movies');
    } else if (router.pathname.startsWith('/tv')) {
      router.push('/discover/tv');
    } else if (router.pathname.startsWith('/lists/')) {
      router.push('/lists');
    } else {
      router.push('/');
    }
  }, [router]);

  return (
    // Discover's customize mode and the menus share the menu being arranged.
    <NavLayoutProvider>
      <div className="flex h-full min-h-full min-w-0 bg-page">
        <div className="pwa-only fixed inset-0 z-20 h-1 w-full border-subtle md:border-t" />
        <div className="absolute top-0 h-64 w-full bg-gradient-to-bl from-surface to-page">
          <div className="relative inset-0 h-full w-full bg-gradient-to-t from-page to-transparent" />
        </div>
        <Sidebar
          open={isSidebarOpen}
          setClosed={() => setSidebarOpen(false)}
          pendingRequestsCount={requestResponse?.pending ?? 0}
          openIssuesCount={issueResponse?.open ?? 0}
          revalidateIssueCount={() => revalidateIssueCount()}
          revalidateRequestsCount={() => revalidateRequestsCount()}
        />
        <div className="sm:hidden">
          <MobileMenu
            pendingRequestsCount={requestResponse?.pending ?? 0}
            openIssuesCount={issueResponse?.open ?? 0}
            revalidateIssueCount={() => revalidateIssueCount()}
            revalidateRequestsCount={() => revalidateRequestsCount()}
          />
        </div>

        <div className="relative mb-16 flex w-0 min-w-0 flex-1 flex-col lg:ml-64">
          <PullToRefresh />
          <div
            className={`searchbar fixed left-0 right-0 top-0 z-10 flex flex-shrink-0 transition duration-300 ${
              isScrolled
                ? 'top-bar-blur bg-surface-raised/panel'
                : 'bg-transparent'
            } lg:left-64`}
            data-seerr="top-bar"
          >
            <div className="flex flex-1 items-center justify-between px-4 md:pl-4 md:pr-4">
              <button
                className={`mr-2 hidden text-strong sm:block ${
                  isScrolled ? 'opacity-90' : 'opacity-70'
                } transition duration-300 focus:outline-none lg:hidden`}
                aria-label={intl.formatMessage(messages.openSidebar)}
                onClick={() => setSidebarOpen(true)}
                data-testid="sidebar-toggle"
              >
                <Bars3BottomLeftIcon className="h-7 w-7" />
              </button>
              <button
                aria-label={intl.formatMessage(messages.goBack)}
                className={`mr-2 text-strong ${
                  isScrolled ? 'opacity-90' : 'opacity-70'
                } transition duration-300 hover:text-strong focus:text-strong focus:outline-none`}
                onClick={goBack}
              >
                <ArrowLeftIcon className="w-7" />
              </button>
              <SearchInput />
              <AiChat />
              <div className="flex items-center">
                <UserDropdown />
              </div>
            </div>
          </div>

          <main
            className="relative top-16 z-0 focus:outline-none"
            tabIndex={0}
            data-seerr="page"
          >
            <div className="mb-6">
              <div className="max-w-8xl mx-auto px-4">
                <UserWarnings />
                {/* One of these at a time, in order: see NoticeQueue. */}
                <PushOptInBanner />
                <PasskeyNudge />
                <WatchSuggestions />
                <SeasonalNote />
                {children}
              </div>
            </div>
          </main>
        </div>
      </div>
    </NavLayoutProvider>
  );
};

export default Layout;
