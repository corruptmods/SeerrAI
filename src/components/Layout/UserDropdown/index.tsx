import CachedImage from '@app/components/Common/CachedImage';
import MiniQuotaDisplay from '@app/components/Layout/UserDropdown/MiniQuotaDisplay';
import useLogout from '@app/hooks/useLogout';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import {
  Menu,
  MenuButton,
  MenuItem,
  MenuItems,
  Transition,
} from '@headlessui/react';
import {
  ArrowRightOnRectangleIcon,
  ClockIcon,
} from '@heroicons/react/24/outline';
import { CogIcon, UserIcon } from '@heroicons/react/24/solid';
import { shownEmail } from '@server/constants/oidc';
import type { LinkProps } from 'next/link';
import Link from 'next/link';
import { Fragment, forwardRef } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Layout.UserDropdown', {
  myprofile: 'Profile',
  accountMenu: 'Account Menu',
  settings: 'Settings',
  requests: 'Requests',
  signout: 'Sign Out',
});

const ForwardedLink = forwardRef<
  HTMLAnchorElement,
  LinkProps & React.ComponentPropsWithoutRef<'a'>
>(({ href, children, ...rest }, ref) => {
  return (
    <Link href={href} ref={ref} {...rest}>
      {children}
    </Link>
  );
});

ForwardedLink.displayName = 'ForwardedLink';

const UserDropdown = () => {
  const intl = useIntl();
  const { user, hasPermission } = useUser();

  const logout = useLogout();

  return (
    <Menu as="div" className="relative ml-2">
      <div>
        {/* The same size and edge as the AI button beside it. */}
        <MenuButton
          className="flex h-10 w-10 flex-none items-center justify-center overflow-hidden rounded-full border border-strong text-sm transition hover:border-gray-500 focus:border-gray-500 focus:outline-none"
          data-testid="user-menu"
          aria-label={intl.formatMessage(messages.accountMenu)}
        >
          <CachedImage
            type="avatar"
            className="h-full w-full rounded-full object-cover"
            src={user ? user.avatar : ''}
            alt=""
            width={40}
            height={40}
          />
        </MenuButton>
      </div>
      <Transition
        as={Fragment}
        enter="transition ease-out duration-100"
        enterFrom="opacity-0 scale-95"
        enterTo="opacity-100 scale-100"
        leave="transition ease-in duration-75"
        leaveFrom="opacity-100 scale-100"
        leaveTo="opacity-0 scale-95"
        appear
      >
        <MenuItems
          className="absolute right-0 mt-2 w-72 origin-top-right rounded-md shadow-lg"
          data-seerr="user-menu"
        >
          <div className="divide-y divide-subtle rounded-md bg-surface/panel ring-1 ring-subtle backdrop-blur">
            <div className="flex flex-col space-y-4 px-4 py-4">
              <div className="flex items-center space-x-2">
                <CachedImage
                  type="avatar"
                  className="h-8 w-8 rounded-full object-cover sm:h-10 sm:w-10"
                  src={user ? user.avatar : ''}
                  alt=""
                  width={40}
                  height={40}
                />
                <div className="flex min-w-0 flex-col">
                  <span className="break-words text-xl font-semibold text-gray-200">
                    {user?.displayName}
                  </span>
                  {shownEmail(user?.displayName, user?.email) && (
                    <span className="text-sm text-muted [overflow-wrap:anywhere]">
                      {user?.email}
                    </span>
                  )}
                </div>
              </div>
              {user && <MiniQuotaDisplay userId={user?.id} />}
            </div>
            <div className="p-1">
              <MenuItem>
                {({ active }) => (
                  <ForwardedLink
                    href={`/profile`}
                    className={`flex items-center rounded px-4 py-2 text-sm font-medium text-gray-200 transition duration-150 ease-in-out ${
                      active
                        ? 'bg-gradient-to-br from-accent to-accent-alt text-on-accent'
                        : ''
                    }`}
                    data-testid="user-menu-profile"
                  >
                    <UserIcon className="mr-2 inline h-5 w-5" />
                    <span>{intl.formatMessage(messages.myprofile)}</span>
                  </ForwardedLink>
                )}
              </MenuItem>
              <MenuItem>
                {({ active }) => (
                  <ForwardedLink
                    href={
                      hasPermission(
                        [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
                        { type: 'or' }
                      )
                        ? `/users/${user?.id}/requests?filter=all`
                        : '/requests'
                    }
                    className={`flex items-center rounded px-4 py-2 text-sm font-medium text-gray-200 transition duration-150 ease-in-out ${
                      active
                        ? 'bg-gradient-to-br from-accent to-accent-alt text-on-accent'
                        : ''
                    }`}
                    data-testid="user-menu-settings"
                  >
                    <ClockIcon className="mr-2 inline h-5 w-5" />
                    <span>{intl.formatMessage(messages.requests)}</span>
                  </ForwardedLink>
                )}
              </MenuItem>
              <MenuItem>
                {({ active }) => (
                  <ForwardedLink
                    href={`/profile/settings`}
                    className={`flex items-center rounded px-4 py-2 text-sm font-medium text-gray-200 transition duration-150 ease-in-out ${
                      active
                        ? 'bg-gradient-to-br from-accent to-accent-alt text-on-accent'
                        : ''
                    }`}
                    data-testid="user-menu-settings"
                  >
                    <CogIcon className="mr-2 inline h-5 w-5" />
                    <span>{intl.formatMessage(messages.settings)}</span>
                  </ForwardedLink>
                )}
              </MenuItem>
              <MenuItem>
                {({ active }) => (
                  <a
                    href="#"
                    className={`flex items-center rounded px-4 py-2 text-sm font-medium text-gray-200 transition duration-150 ease-in-out ${
                      active
                        ? 'bg-gradient-to-br from-accent to-accent-alt text-on-accent'
                        : ''
                    }`}
                    onClick={() => logout()}
                  >
                    <ArrowRightOnRectangleIcon className="mr-2 inline h-5 w-5" />
                    <span>{intl.formatMessage(messages.signout)}</span>
                  </a>
                )}
              </MenuItem>
            </div>
          </div>
        </MenuItems>
      </Transition>
    </Menu>
  );
};

export default UserDropdown;
