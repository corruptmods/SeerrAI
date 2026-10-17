import Dropdown from '@app/components/Common/Dropdown';
import defineMessages from '@app/utils/defineMessages';
import { withProperties } from '@app/utils/typeHelpers';
import { Menu, MenuButton } from '@headlessui/react';
import { ChevronDownIcon } from '@heroicons/react/24/solid';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Common.ButtonWithDropdown', {
  more: 'More options',
});

type ButtonWithDropdownProps = {
  text: React.ReactNode;
  dropdownIcon?: React.ReactNode;
  buttonType?: 'primary' | 'ghost';
} & (
  | ({ as?: 'button' } & ButtonHTMLAttributes<HTMLButtonElement>)
  | ({ as: 'a' } & AnchorHTMLAttributes<HTMLAnchorElement>)
);

const ButtonWithDropdown = ({
  text,
  children,
  dropdownIcon,
  className,
  buttonType = 'primary',
  ...props
}: ButtonWithDropdownProps) => {
  const intl = useIntl();
  const styleClasses = {
    mainButtonClasses: 'button-md border',
    dropdownSideButtonClasses: 'button-md border',
  };

  switch (buttonType) {
    case 'ghost':
      styleClasses.mainButtonClasses +=
        ' text-strong bg-transparent border-strong hover:border-gray-200 focus:border-gray-100 active:border-gray-100';
      styleClasses.dropdownSideButtonClasses = styleClasses.mainButtonClasses;
      break;
    default:
      styleClasses.mainButtonClasses +=
        ' text-on-accent bg-accent/accent-fill border-accent-hover hover:bg-accent hover:border-accent-hover active:bg-indigo-700 active:border-indigo-700 focus:ring-blue';
      styleClasses.dropdownSideButtonClasses +=
        ' text-on-accent bg-accent/accent-fill border-accent-hover hover:bg-accent active:bg-accent focus:ring-blue';
  }

  const TriggerElement = props.as ?? 'button';

  return (
    <Menu as="div" className="relative z-10 inline-flex">
      <TriggerElement
        type="button"
        className={`relative z-10 inline-flex h-full items-center px-4 py-2 text-sm font-medium leading-5 transition duration-150 ease-in-out hover:z-20 focus:z-20 focus:outline-none ${
          styleClasses.mainButtonClasses
        } ${children ? 'rounded-l-md' : 'rounded-md'} ${className}`}
        {...(props as Record<string, string>)}
      >
        {text}
      </TriggerElement>
      {children && (
        <span className="relative -ml-px block">
          <MenuButton
            type="button"
            className={`relative z-10 inline-flex h-full items-center rounded-r-md px-2 py-2 text-sm font-medium leading-5 transition duration-150 ease-in-out hover:z-20 focus:z-20 ${styleClasses.dropdownSideButtonClasses}`}
            aria-label={intl.formatMessage(messages.more)}
          >
            {dropdownIcon ? dropdownIcon : <ChevronDownIcon />}
          </MenuButton>
          <Dropdown.Items dropdownType={buttonType}>{children}</Dropdown.Items>
        </span>
      )}
    </Menu>
  );
};
export default withProperties(ButtonWithDropdown, { Item: Dropdown.Item });
