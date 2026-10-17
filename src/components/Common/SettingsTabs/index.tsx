import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import type { Permission } from '@server/lib/permissions';
import { hasPermission } from '@server/lib/permissions';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Common.SettingsTabs', {
  selectTab: 'Select a Tab',
  tabs: 'Tabs',
});

export interface SettingsRoute {
  text: string;
  content?: React.ReactNode;
  route: string;
  regex: RegExp;
  requiredPermission?: Permission | Permission[];
  permissionType?: { type: 'and' | 'or' };
  hidden?: boolean;
}

type SettingsLinkProps = {
  tabType: 'default' | 'button';
  currentPath: string;
  route: string;
  regex: RegExp;
  hidden?: boolean;
  isMobile?: boolean;
  children: React.ReactNode;
};

const SettingsLink = ({
  children,
  tabType,
  currentPath,
  route,
  regex,
  hidden = false,
  isMobile = false,
}: SettingsLinkProps) => {
  if (hidden) {
    return null;
  }

  if (isMobile) {
    return <option value={route}>{children}</option>;
  }

  let linkClasses =
    'px-1 py-4 ml-8 text-sm font-medium leading-5 transition duration-300 border-b-2 border-transparent whitespace-nowrap first:ml-0';
  let activeLinkColor = 'text-accent-text border-indigo-600';
  let inactiveLinkColor =
    'text-gray-500 border-transparent hover:text-gray-300 hover:border-gray-400 focus:text-gray-300 focus:border-gray-400';

  if (tabType === 'button') {
    linkClasses =
      'px-3 py-2 text-sm font-medium transition duration-300 rounded-md whitespace-nowrap mx-2 my-1';
    activeLinkColor = 'bg-indigo-700 text-white';
    inactiveLinkColor = 'bg-gray-800 hover:bg-gray-700 focus:bg-gray-700';
  }

  return (
    <Link
      href={route}
      className={`${linkClasses} ${
        currentPath.match(regex) ? activeLinkColor : inactiveLinkColor
      }`}
      aria-current="page"
    >
      {children}
    </Link>
  );
};

const SettingsTabs = ({
  tabType = 'default',
  settingsRoutes,
}: {
  tabType?: 'default' | 'button';
  settingsRoutes: SettingsRoute[];
}) => {
  const intl = useIntl();
  const router = useRouter();
  const { user: currentUser } = useUser();

  /*
   * Load the other sections' code in the background once this one has
   * settled. Each page's code otherwise downloads the first time it is
   * opened — over half a megabyte for Services — so the first visit to each
   * was slow. Links pre-load themselves, but on a phone these tabs are a
   * dropdown, which never did. Next.js only downloads here, without running
   * anything, and the service worker keeps it across restarts, so this costs
   * once per update. One page at a time, after a pause so the open page
   * comes first; it stops when the menu goes away. Only sections this user
   * can see.
   */
  const visibleRoutes = settingsRoutes
    .filter(
      (route) =>
        !route.hidden &&
        (route.requiredPermission
          ? hasPermission(
              route.requiredPermission,
              currentUser?.permissions ?? 0,
              route.permissionType
            )
          : true)
    )
    .map((route) => route.route)
    .join('|');

  useEffect(() => {
    if (!visibleRoutes) {
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      for (const route of visibleRoutes.split('|')) {
        if (cancelled) {
          return;
        }
        try {
          await router.prefetch(route);
        } catch {
          // Best-effort; the page still loads when opened.
        }
      }
    }, 1500);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // The router object changes on every navigation; the list does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleRoutes]);

  return (
    <>
      <div className="sm:hidden">
        <label htmlFor="tabs" className="sr-only">
          {intl.formatMessage(messages.selectTab)}
        </label>
        <select
          id="tabs"
          onChange={(e) => {
            router.push(e.target.value);
          }}
          onBlur={(e) => {
            router.push(e.target.value);
          }}
          defaultValue={
            settingsRoutes.find((route) => !!router.pathname.match(route.regex))
              ?.route
          }
        >
          {settingsRoutes
            .filter(
              (route) =>
                !route.hidden &&
                (route.requiredPermission
                  ? hasPermission(
                      route.requiredPermission,
                      currentUser?.permissions ?? 0,
                      route.permissionType
                    )
                  : true)
            )
            .map((route, index) => (
              <SettingsLink
                tabType={tabType}
                currentPath={router.pathname}
                route={route.route}
                regex={route.regex}
                hidden={route.hidden ?? false}
                isMobile
                key={`mobile-settings-link-${index}`}
              >
                {route.text}
              </SettingsLink>
            ))}
        </select>
      </div>
      {tabType === 'button' ? (
        <div className="hidden sm:block">
          <nav
            className="-mx-2 -my-1 flex flex-wrap"
            aria-label={intl.formatMessage(messages.tabs)}
          >
            {settingsRoutes.map((route, index) => (
              <SettingsLink
                tabType={tabType}
                currentPath={router.pathname}
                route={route.route}
                regex={route.regex}
                hidden={route.hidden ?? false}
                key={`button-settings-link-${index}`}
              >
                {route.content ?? route.text}
              </SettingsLink>
            ))}
          </nav>
        </div>
      ) : (
        <div className="hide-scrollbar hidden overflow-x-scroll border-b border-gray-600 sm:block">
          <nav className="flex" data-testid="settings-nav-desktop">
            {settingsRoutes
              .filter(
                (route) =>
                  !route.hidden &&
                  (route.requiredPermission
                    ? hasPermission(
                        route.requiredPermission,
                        currentUser?.permissions ?? 0,
                        route.permissionType
                      )
                    : true)
              )
              .map((route, index) => (
                <SettingsLink
                  tabType={tabType}
                  currentPath={router.pathname}
                  route={route.route}
                  regex={route.regex}
                  key={`standard-settings-link-${index}`}
                >
                  {route.text}
                </SettingsLink>
              ))}
          </nav>
        </div>
      )}
    </>
  );
};

export default SettingsTabs;
