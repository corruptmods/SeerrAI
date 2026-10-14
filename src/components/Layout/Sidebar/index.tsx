import Badge from '@app/components/Common/Badge';
import BrandLogo from '@app/components/Layout/Sidebar/BrandLogo';
import VersionStatus from '@app/components/Layout/VersionStatus';
import { loadNavEditor, useNavLayout } from '@app/context/NavLayoutContext';
import useClickOutside from '@app/hooks/useClickOutside';
import { useFeatureCheck } from '@app/hooks/useFeature';
import useLazyModule from '@app/hooks/useLazyModule';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { Transition, TransitionChild } from '@headlessui/react';
import {
  BookmarkIcon,
  CalendarDaysIcon,
  ClockIcon,
  CogIcon,
  DocumentMagnifyingGlassIcon,
  ExclamationTriangleIcon,
  EyeSlashIcon,
  FilmIcon,
  MusicalNoteIcon,
  SparklesIcon,
  TvIcon,
  UsersIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type { Feature } from '@server/constants/features';
import type { NavItem } from '@server/constants/navigation';
import { sortByNavOrder, withoutHiddenNav } from '@server/constants/navigation';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { Fragment, useEffect, useRef } from 'react';
import { useIntl } from 'react-intl';

export const menuMessages = defineMessages('components.Layout.Sidebar', {
  dashboard: 'Discover',
  browsemovies: 'Movies',
  browsetv: 'Series',
  music: 'Music',
  requests: 'Requests',
  calendar: 'Calendar',
  blocklist: 'Blocklist',
  watchlists: 'Watch Lists',
  issues: 'Issues',
  users: 'Users',
  backfill: 'Backfill',
  settings: 'Settings',
  closeSidebar: 'Close sidebar',
});

interface SidebarProps {
  open?: boolean;
  setClosed: () => void;
  pendingRequestsCount: number;
  openIssuesCount: number;
  revalidateIssueCount: () => void;
  revalidateRequestsCount: () => void;
}

interface SidebarLinkProps {
  /** Its name in each person's own order (server/constants/navigation). */
  id: NavItem;
  href: string;
  svgIcon: React.ReactNode;
  messagesKey: keyof typeof menuMessages;
  activeRegExp: RegExp;
  as?: string;
  requiredPermission?: Permission | Permission[];
  /** Shown only while this optional feature is on. */
  feature?: Feature;
  permissionType?: 'and' | 'or';
  dataTestId?: string;
}

/** In the usual order; each person can arrange their own. */
const SidebarLinks: SidebarLinkProps[] = [
  {
    id: 'discover',
    href: '/',
    messagesKey: 'dashboard',
    svgIcon: <SparklesIcon className="mr-3 h-6 w-6" />,
    activeRegExp: /^\/(discover\/?)?$/,
  },
  {
    id: 'movies',
    href: '/discover/movies',
    messagesKey: 'browsemovies',
    svgIcon: <FilmIcon className="mr-3 h-6 w-6" />,
    activeRegExp: /^\/discover\/movies$/,
  },
  {
    id: 'series',
    href: '/discover/tv',
    messagesKey: 'browsetv',
    svgIcon: <TvIcon className="mr-3 h-6 w-6" />,
    activeRegExp: /^\/discover\/tv$/,
  },
  {
    id: 'music',
    href: '/discover/music',
    messagesKey: 'music',
    // Only once Lidarr is set up, and for people with music on.
    feature: 'music',
    svgIcon: <MusicalNoteIcon className="mr-3 h-6 w-6" />,
    activeRegExp: /^\/(discover\/music|music\/)/,
  },
  {
    id: 'requests',
    href: '/requests',
    messagesKey: 'requests',
    svgIcon: <ClockIcon className="mr-3 h-6 w-6" />,
    activeRegExp: /^\/requests/,
  },
  {
    id: 'calendar',
    href: '/calendar',
    messagesKey: 'calendar',
    feature: 'releaseCalendar',
    svgIcon: <CalendarDaysIcon className="mr-3 h-6 w-6" />,
    activeRegExp: /^\/calendar/,
  },
  {
    id: 'lists',
    href: '/lists',
    messagesKey: 'watchlists',
    svgIcon: <BookmarkIcon className="mr-3 h-6 w-6" />,
    activeRegExp: /^\/lists/,
  },
  {
    id: 'blocklist',
    href: '/blocklist',
    messagesKey: 'blocklist',
    svgIcon: <EyeSlashIcon className="mr-3 h-6 w-6" />,
    activeRegExp: /^\/blocklist/,
    requiredPermission: [
      Permission.MANAGE_BLOCKLIST,
      Permission.VIEW_BLOCKLIST,
    ],
    permissionType: 'or',
  },
  {
    id: 'issues',
    href: '/issues',
    messagesKey: 'issues',
    svgIcon: <ExclamationTriangleIcon className="mr-3 h-6 w-6" />,
    activeRegExp: /^\/issues/,
    requiredPermission: [
      Permission.MANAGE_ISSUES,
      Permission.CREATE_ISSUES,
      Permission.VIEW_ISSUES,
    ],
    permissionType: 'or',
  },
  {
    id: 'users',
    href: '/users',
    messagesKey: 'users',
    svgIcon: <UsersIcon className="mr-3 h-6 w-6" />,
    activeRegExp: /^\/users/,
    requiredPermission: Permission.MANAGE_USERS,
    dataTestId: 'sidebar-menu-users',
  },
  {
    id: 'backfill',
    href: '/backfill',
    messagesKey: 'backfill',
    svgIcon: <DocumentMagnifyingGlassIcon className="mr-3 h-6 w-6" />,
    activeRegExp: /^\/backfill/,
    requiredPermission: Permission.ADMIN,
    dataTestId: 'sidebar-menu-backfill',
  },
  {
    id: 'settings',
    href: '/settings',
    messagesKey: 'settings',
    svgIcon: <CogIcon className="mr-3 h-6 w-6" />,
    activeRegExp: /^\/settings/,
    requiredPermission: Permission.ADMIN,
    dataTestId: 'sidebar-menu-settings',
  },
];

const Sidebar = ({
  open,
  setClosed,
  pendingRequestsCount,
  openIssuesCount,
  revalidateIssueCount,
  revalidateRequestsCount,
}: SidebarProps) => {
  const navRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const intl = useIntl();
  const { hasPermission } = useUser();
  const featureIsOn = useFeatureCheck();
  const { draft, setDraft, order, hidden } = useNavLayout();
  // Discover loads it as customizing starts, and says so if it can't.
  const NavEditor = useLazyModule(loadNavEditor, !!draft, () => undefined);
  useClickOutside(navRef, () => setClosed());

  // The items this person can use, in their order. Items they cannot use
  // (a permission, a feature switched off) keep their place in it, and are
  // left out here whatever they chose.
  const usable = sortByNavOrder(SidebarLinks, order)
    .filter((link) => !link.feature || featureIsOn(link.feature))
    .filter((link) =>
      link.requiredPermission
        ? hasPermission(link.requiredPermission, {
            type: link.permissionType ?? 'and',
          })
        : true
    );
  const links = withoutHiddenNav(usable, hidden);

  // While they arrange their menu (from Discover), the editor takes the
  // links' place.
  const editor =
    draft && NavEditor ? (
      <NavEditor
        items={usable.map((link) => ({
          id: link.id,
          name: intl.formatMessage(menuMessages[link.messagesKey]),
          icon: link.svgIcon as React.ReactElement<{ className?: string }>,
        }))}
        draft={draft}
        onChange={setDraft}
      />
    ) : null;

  useEffect(() => {
    if (openIssuesCount) {
      revalidateIssueCount();
    }

    if (pendingRequestsCount) {
      revalidateRequestsCount();
    }
  }, [
    revalidateIssueCount,
    revalidateRequestsCount,
    pendingRequestsCount,
    openIssuesCount,
  ]);

  return (
    <>
      <div className="lg:hidden">
        <Transition as={Fragment} show={open}>
          <div className="fixed inset-0 z-40 flex">
            <TransitionChild
              as="div"
              enter="transition-opacity ease-linear duration-300"
              enterFrom="opacity-0"
              enterTo="opacity-100"
              leave="transition-opacity ease-linear duration-300"
              leaveFrom="opacity-100"
              leaveTo="opacity-0"
            >
              <div className="fixed inset-0">
                <div className="absolute inset-0 bg-gray-900 opacity-90" />
              </div>
            </TransitionChild>
            <TransitionChild
              as="div"
              enter="transition-transform ease-in-out duration-300"
              enterFrom="-translate-x-full"
              enterTo="translate-x-0"
              leave="transition-transform ease-in-out duration-300"
              leaveFrom="translate-x-0"
              leaveTo="-translate-x-full"
            >
              <>
                <div className="sidebar relative flex h-full w-full max-w-xs flex-1 flex-col bg-gray-800">
                  <div className="sidebar-close-button absolute right-0 -mr-14 p-1">
                    <button
                      className="flex h-12 w-12 items-center justify-center rounded-full focus:bg-gray-600 focus:outline-none"
                      aria-label={intl.formatMessage(menuMessages.closeSidebar)}
                      onClick={() => setClosed()}
                    >
                      <XMarkIcon className="h-6 w-6 text-white" />
                    </button>
                  </div>
                  <div
                    ref={navRef}
                    className="flex flex-1 flex-col overflow-y-auto pb-8 pt-4 sm:pb-4"
                  >
                    <div className="flex flex-shrink-0 items-center px-2">
                      <span className="w-full px-4 text-xl text-gray-50">
                        <Link href="/" className="block h-24 w-64">
                          <BrandLogo />
                        </Link>
                      </span>
                    </div>
                    <nav className="mt-10 flex-1 space-y-4 px-4">
                      {editor ??
                        links.map((sidebarLink) => {
                          return (
                            <Link
                              key={`mobile-${sidebarLink.messagesKey}`}
                              href={sidebarLink.href}
                              as={sidebarLink.as}
                              onClick={() => setClosed()}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  setClosed();
                                }
                              }}
                              role="button"
                              tabIndex={0}
                              className={`flex items-center rounded-md px-2 py-2 text-base font-medium leading-6 text-white transition duration-150 ease-in-out focus:outline-none ${
                                router.pathname.match(sidebarLink.activeRegExp)
                                  ? 'bg-gradient-to-br from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500'
                                  : 'hover:bg-gray-700 focus:bg-gray-700'
                              } `}
                              data-testid={`${sidebarLink.dataTestId}-mobile`}
                            >
                              {sidebarLink.svgIcon}
                              {intl.formatMessage(
                                menuMessages[sidebarLink.messagesKey]
                              )}
                            </Link>
                          );
                        })}
                    </nav>
                    {hasPermission(Permission.ADMIN) && (
                      <div className="px-2">
                        <VersionStatus onClick={() => setClosed()} />
                      </div>
                    )}
                  </div>
                </div>
                <div className="w-14 flex-shrink-0">
                  {/* <!-- Force sidebar to shrink to fit close icon --> */}
                </div>
              </>
            </TransitionChild>
          </div>
        </Transition>
      </div>

      <div className="fixed bottom-0 left-0 top-0 z-30 hidden lg:flex lg:flex-shrink-0">
        <div className="sidebar flex w-64 flex-col">
          <div className="flex h-0 flex-1 flex-col">
            <div className="flex flex-1 flex-col overflow-y-auto pb-4">
              <div className="flex flex-shrink-0 items-center">
                <span className="w-full px-4 py-2 text-2xl text-gray-50">
                  <Link href="/" className="block h-24">
                    <BrandLogo eager />
                  </Link>
                </span>
              </div>
              <nav className="mt-8 flex-1 space-y-4 px-4">
                {editor ??
                  links.map((sidebarLink) => {
                    return (
                      <Link
                        key={`desktop-${sidebarLink.messagesKey}`}
                        href={sidebarLink.href}
                        as={sidebarLink.as}
                        className={`group flex items-center rounded-md px-2 py-2 text-lg font-medium leading-6 text-white transition duration-150 ease-in-out focus:outline-none ${
                          router.pathname.match(sidebarLink.activeRegExp)
                            ? 'bg-gradient-to-br from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500'
                            : 'hover:bg-gray-700 focus:bg-gray-700'
                        } `}
                        data-testid={sidebarLink.dataTestId}
                      >
                        {sidebarLink.svgIcon}
                        {intl.formatMessage(
                          menuMessages[sidebarLink.messagesKey]
                        )}
                        {sidebarLink.messagesKey === 'requests' &&
                          pendingRequestsCount > 0 &&
                          hasPermission(Permission.MANAGE_REQUESTS) && (
                            <div className="ml-auto flex">
                              <Badge
                                className={`rounded-md bg-gradient-to-br ${
                                  router.pathname.match(
                                    sidebarLink.activeRegExp
                                  )
                                    ? 'border-indigo-600 from-indigo-700 to-purple-700'
                                    : 'border-indigo-500 from-indigo-600 to-purple-600'
                                }`}
                              >
                                {pendingRequestsCount}
                              </Badge>
                            </div>
                          )}
                        {sidebarLink.messagesKey === 'issues' &&
                          openIssuesCount > 0 &&
                          hasPermission(Permission.MANAGE_ISSUES) && (
                            <div className="ml-auto flex">
                              <Badge
                                className={`rounded-md bg-gradient-to-br ${
                                  router.pathname.match(
                                    sidebarLink.activeRegExp
                                  )
                                    ? 'border-indigo-600 from-indigo-700 to-purple-700'
                                    : 'border-indigo-500 from-indigo-600 to-purple-600'
                                }`}
                              >
                                {openIssuesCount}
                              </Badge>
                            </div>
                          )}
                      </Link>
                    );
                  })}
              </nav>
              {hasPermission(Permission.ADMIN) && (
                <div className="px-2">
                  <VersionStatus />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default Sidebar;
