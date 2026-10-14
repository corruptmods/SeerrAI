import Badge from '@app/components/Common/Badge';
import { menuMessages } from '@app/components/Layout/Sidebar';
import { loadNavEditor, useNavLayout } from '@app/context/NavLayoutContext';
import useClickOutside from '@app/hooks/useClickOutside';
import { useFeatureCheck } from '@app/hooks/useFeature';
import useLazyModule from '@app/hooks/useLazyModule';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import {
  AdjustmentsHorizontalIcon,
  BookmarkIcon,
  CalendarDaysIcon,
  ClockIcon,
  CogIcon,
  DocumentMagnifyingGlassIcon,
  EllipsisHorizontalIcon,
  ExclamationTriangleIcon,
  EyeSlashIcon,
  BookmarkIcon as FilledBookmarkIcon,
  FilmIcon,
  MusicalNoteIcon,
  SparklesIcon,
  TvIcon,
  UsersIcon,
} from '@heroicons/react/24/outline';
import {
  CalendarDaysIcon as FilledCalendarDaysIcon,
  ClockIcon as FilledClockIcon,
  CogIcon as FilledCogIcon,
  DocumentMagnifyingGlassIcon as FilledDocumentMagnifyingGlassIcon,
  ExclamationTriangleIcon as FilledExclamationTriangleIcon,
  EyeSlashIcon as FilledEyeSlashIcon,
  FilmIcon as FilledFilmIcon,
  MusicalNoteIcon as FilledMusicalNoteIcon,
  SparklesIcon as FilledSparklesIcon,
  TvIcon as FilledTvIcon,
  UsersIcon as FilledUsersIcon,
  XMarkIcon,
} from '@heroicons/react/24/solid';
import type { Feature } from '@server/constants/features';
import type { NavItem } from '@server/constants/navigation';
import {
  isDefaultNavOrder,
  sortByNavOrder,
  withoutHiddenNav,
} from '@server/constants/navigation';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { cloneElement, useEffect, useRef, useState, type JSX } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Layout.MobileMenu', {
  more: 'More',
  arrangeMenu: 'Arrange menu',
});

interface MobileMenuProps {
  pendingRequestsCount: number;
  openIssuesCount: number;
  revalidateIssueCount: () => void;
  revalidateRequestsCount: () => void;
}

interface MenuLink {
  /** Its name in each person's own order (server/constants/navigation). */
  id: NavItem;
  href: string;
  svgIcon: JSX.Element;
  svgIconSelected: JSX.Element;
  content: React.ReactNode;
  activeRegExp: RegExp;
  as?: string;
  requiredPermission?: Permission | Permission[];
  /** Shown only while this optional feature is on. */
  feature?: Feature;
  permissionType?: 'and' | 'or';
  dataTestId?: string;
}

const MobileMenu = ({
  pendingRequestsCount,
  openIssuesCount,
  revalidateIssueCount,
  revalidateRequestsCount,
}: MobileMenuProps) => {
  const ref = useRef<HTMLDivElement>(null);
  const intl = useIntl();
  const [isOpen, setIsOpen] = useState(false);
  const { hasPermission } = useUser();
  const featureIsOn = useFeatureCheck();
  const router = useRouter();
  const { draft, setDraft, order, hidden } = useNavLayout();
  // Discover loads it as customizing starts, and says so if it can't.
  const NavEditor = useLazyModule(loadNavEditor, !!draft, () => undefined);
  const editing = !!draft;
  useClickOutside(ref, () => {
    setTimeout(() => {
      if (isOpen) {
        setIsOpen(false);
      }
    }, 150);
  });

  const toggle = () => setIsOpen(!isOpen);

  const menuLinks: MenuLink[] = [
    {
      id: 'discover',
      href: '/',
      content: intl.formatMessage(menuMessages.dashboard),
      svgIcon: <SparklesIcon className="h-6 w-6" />,
      svgIconSelected: <FilledSparklesIcon className="h-6 w-6" />,
      activeRegExp: /^\/(discover\/?)?$/,
    },
    {
      id: 'movies',
      href: '/discover/movies',
      content: intl.formatMessage(menuMessages.browsemovies),
      svgIcon: <FilmIcon className="h-6 w-6" />,
      svgIconSelected: <FilledFilmIcon className="h-6 w-6" />,
      activeRegExp: /^\/discover\/movies$/,
    },
    {
      id: 'series',
      href: '/discover/tv',
      content: intl.formatMessage(menuMessages.browsetv),
      svgIcon: <TvIcon className="h-6 w-6" />,
      svgIconSelected: <FilledTvIcon className="h-6 w-6" />,
      activeRegExp: /^\/discover\/tv$/,
    },
    {
      id: 'lists',
      href: '/lists',
      content: intl.formatMessage(menuMessages.watchlists),
      svgIcon: <BookmarkIcon className="h-6 w-6" />,
      svgIconSelected: <FilledBookmarkIcon className="h-6 w-6" />,
      activeRegExp: /^\/lists/,
    },
    {
      id: 'requests',
      href: '/requests',
      content: intl.formatMessage(menuMessages.requests),
      svgIcon: <ClockIcon className="h-6 w-6" />,
      svgIconSelected: <FilledClockIcon className="h-6 w-6" />,
      activeRegExp: /^\/requests/,
    },
    {
      id: 'music',
      href: '/discover/music',
      content: intl.formatMessage(menuMessages.music),
      // Only once Lidarr is set up, and for people with music on. After
      // the bar's five, so the bar stays as it was.
      feature: 'music',
      svgIcon: <MusicalNoteIcon className="h-6 w-6" />,
      svgIconSelected: <FilledMusicalNoteIcon className="h-6 w-6" />,
      activeRegExp: /^\/(discover\/music|music\/)/,
    },
    {
      id: 'calendar',
      href: '/calendar',
      content: intl.formatMessage(menuMessages.calendar),
      feature: 'releaseCalendar',
      svgIcon: <CalendarDaysIcon className="h-6 w-6" />,
      svgIconSelected: <FilledCalendarDaysIcon className="h-6 w-6" />,
      activeRegExp: /^\/calendar/,
    },
    {
      id: 'blocklist',
      href: '/blocklist',
      content: intl.formatMessage(menuMessages.blocklist),
      svgIcon: <EyeSlashIcon className="h-6 w-6" />,
      svgIconSelected: <FilledEyeSlashIcon className="h-6 w-6" />,
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
      content: intl.formatMessage(menuMessages.issues),
      svgIcon: <ExclamationTriangleIcon className="h-6 w-6" />,
      svgIconSelected: <FilledExclamationTriangleIcon className="h-6 w-6" />,
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
      content: intl.formatMessage(menuMessages.users),
      svgIcon: <UsersIcon className="mr-3 h-6 w-6" />,
      svgIconSelected: <FilledUsersIcon className="mr-3 h-6 w-6" />,
      activeRegExp: /^\/users/,
      requiredPermission: Permission.MANAGE_USERS,
      dataTestId: 'sidebar-menu-users',
    },
    {
      id: 'backfill',
      href: '/backfill',
      content: intl.formatMessage(menuMessages.backfill),
      svgIcon: <DocumentMagnifyingGlassIcon className="mr-3 h-6 w-6" />,
      svgIconSelected: (
        <FilledDocumentMagnifyingGlassIcon className="mr-3 h-6 w-6" />
      ),
      activeRegExp: /^\/backfill/,
      requiredPermission: Permission.ADMIN,
      dataTestId: 'sidebar-menu-backfill',
    },
    {
      id: 'settings',
      href: '/settings',
      content: intl.formatMessage(menuMessages.settings),
      svgIcon: <CogIcon className="mr-3 h-6 w-6" />,
      svgIconSelected: <FilledCogIcon className="mr-3 h-6 w-6" />,
      activeRegExp: /^\/settings/,
      requiredPermission: Permission.ADMIN,
      dataTestId: 'sidebar-menu-settings',
    },
  ];

  // The phone keeps its own order, with Watch Lists on the bar, until a
  // person puts their menu in an order of their own; then it follows that.
  // Items they cannot use are left out whatever they chose.
  const usableLinks = (
    isDefaultNavOrder(order) ? menuLinks : sortByNavOrder(menuLinks, order)
  ).filter(
    (link) =>
      (!link.feature || featureIsOn(link.feature)) &&
      (!link.requiredPermission ||
        hasPermission(link.requiredPermission, {
          type: link.permissionType ?? 'and',
        }))
  );
  const filteredLinks = withoutHiddenNav(usableLinks, hidden);

  // Customizing ends (saved or not): the editor closes with it.
  useEffect(() => {
    setIsOpen(false);
  }, [editing]);

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
    // Above Discover's Save bar while the menu is being arranged.
    <div
      className={`fixed bottom-0 left-0 right-0 ${
        editing && isOpen ? 'z-[60]' : 'z-50'
      }`}
    >
      <Transition
        show={isOpen}
        as="div"
        ref={ref}
        enter="transition duration-500"
        enterFrom="opacity-0 translate-y-0"
        enterTo="opacity-100 -translate-y-full"
        leave="transition duration-500"
        leaveFrom="opacity-100 -translate-y-full"
        leaveTo="opacity-0 translate-y-0"
        className={`absolute left-0 right-0 top-0 flex w-full -translate-y-full flex-col space-y-6 border-t border-gray-600 bg-gray-900/90 px-6 py-6 font-semibold text-gray-100 backdrop-blur ${
          editing ? 'max-h-[75vh] overflow-y-auto' : ''
        }`}
      >
        {draft && NavEditor ? (
          <NavEditor
            phone
            items={usableLinks.map((link) => ({
              id: link.id,
              name: typeof link.content === 'string' ? link.content : link.id,
              icon: link.svgIcon,
            }))}
            draft={draft}
            onChange={setDraft}
          />
        ) : (
          filteredLinks.map((link) => {
            const isActive = router.pathname.match(link.activeRegExp);
            return (
              <Link
                key={`mobile-menu-link-${link.href}`}
                href={link.href}
                className={`flex items-center ${
                  isActive ? 'text-indigo-500' : ''
                }`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setIsOpen(false);
                  }
                }}
                onClick={() => setIsOpen(false)}
                role="button"
                tabIndex={0}
              >
                {cloneElement(isActive ? link.svgIconSelected : link.svgIcon, {
                  className: 'h-5 w-5',
                })}
                <span className="ml-2">{link.content}</span>
                {link.href === '/requests' &&
                  pendingRequestsCount > 0 &&
                  hasPermission(Permission.MANAGE_REQUESTS) && (
                    <div className="ml-auto flex">
                      <Badge className="rounded-md border-indigo-500 bg-gradient-to-br from-indigo-600 to-purple-600">
                        {pendingRequestsCount}
                      </Badge>
                    </div>
                  )}
                {link.href === '/issues' &&
                  openIssuesCount > 0 &&
                  hasPermission(Permission.MANAGE_ISSUES) && (
                    <div className="ml-auto flex">
                      <Badge className="rounded-md border-indigo-500 bg-gradient-to-br from-indigo-600 to-purple-600">
                        {openIssuesCount}
                      </Badge>
                    </div>
                  )}
              </Link>
            );
          })
        )}
      </Transition>
      <div className="padding-bottom-safe border-t border-gray-600 bg-gray-800/90 backdrop-blur">
        <div className="flex h-full items-center justify-between px-3 py-4 text-gray-100 sm:px-6">
          {filteredLinks.slice(0, 5).map((link) => {
            const isActive =
              router.pathname.match(link.activeRegExp) && !isOpen;
            return (
              <Link
                key={`mobile-menu-link-${link.href}`}
                href={link.href}
                // Icons only on the bar, so the name is given here.
                aria-label={
                  typeof link.content === 'string' ? link.content : undefined
                }
                aria-current={isActive ? 'page' : undefined}
                className={`relative flex flex-col items-center space-y-1 ${
                  isActive ? 'text-indigo-500' : ''
                }`}
              >
                {cloneElement(isActive ? link.svgIconSelected : link.svgIcon, {
                  className: 'h-6 w-6',
                })}
                {link.href === '/requests' &&
                  pendingRequestsCount > 0 &&
                  hasPermission(Permission.MANAGE_REQUESTS) && (
                    <div className="absolute bottom-3 left-3">
                      <Badge
                        className={`bg-gradient-to-br ${
                          router.pathname.match(link.activeRegExp)
                            ? 'border-indigo-600 from-indigo-700 to-purple-700'
                            : 'border-indigo-500 from-indigo-600 to-purple-600'
                        } flex ${
                          pendingRequestsCount > 99 ? 'w-6' : 'w-4'
                        } h-4 items-center justify-center !px-[5px] !py-[7px] text-[8px]`}
                      >
                        {pendingRequestsCount > 99
                          ? '99+'
                          : pendingRequestsCount}
                      </Badge>
                    </div>
                  )}
              </Link>
            );
          })}
          {editing ? (
            <button
              className={`flex flex-col items-center space-y-1 ${
                isOpen ? 'text-indigo-500' : 'text-indigo-300'
              }`}
              onClick={() => toggle()}
              aria-label={intl.formatMessage(
                isOpen ? globalMessages.close : messages.arrangeMenu
              )}
              aria-expanded={isOpen}
              data-testid="mobile-menu-arrange"
            >
              {isOpen ? (
                <XMarkIcon className="h-6 w-6" />
              ) : (
                <AdjustmentsHorizontalIcon className="h-6 w-6" />
              )}
            </button>
          ) : (
            filteredLinks.length > 4 &&
            filteredLinks.length !== 5 && (
              <button
                className={`flex flex-col items-center space-y-1 ${
                  isOpen ? 'text-indigo-500' : ''
                }`}
                onClick={() => toggle()}
                aria-label={intl.formatMessage(
                  isOpen ? globalMessages.close : messages.more
                )}
                aria-expanded={isOpen}
              >
                {isOpen ? (
                  <XMarkIcon className="h-6 w-6" />
                ) : (
                  <EllipsisHorizontalIcon className="h-6 w-6" />
                )}
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
};

export default MobileMenu;
