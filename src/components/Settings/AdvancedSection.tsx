import defineMessages from '@app/utils/defineMessages';
import {
  Disclosure,
  DisclosureButton,
  DisclosurePanel,
} from '@headlessui/react';
import { ChevronDownIcon } from '@heroicons/react/24/outline';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Settings.AdvancedSection', {
  advanced: 'Advanced',
  explain: 'The defaults suit most servers. Change these only for a reason.',
});

/** Collapsible section for rarely needed settings; closed by default. */
const AdvancedSection = ({ children }: { children: React.ReactNode }) => {
  const intl = useIntl();
  return (
    <Disclosure as="div" className="mt-8 rounded-md ring-1 ring-gray-700">
      {({ open }) => (
        <>
          <DisclosureButton className="flex w-full items-center justify-between gap-3 rounded-md px-4 py-3 text-left hover:bg-gray-700/40 focus:outline-none focus-visible:bg-gray-700/40">
            {/* Wraps on phones instead of overflowing the page. */}
            <span className="min-w-0 whitespace-normal">
              <span className="block text-lg font-semibold text-gray-200">
                {intl.formatMessage(messages.advanced)}
              </span>
              <span className="block text-sm text-gray-400">
                {intl.formatMessage(messages.explain)}
              </span>
            </span>
            <ChevronDownIcon
              className={`h-5 w-5 flex-none text-gray-400 transition-transform ${
                open ? 'rotate-180' : ''
              }`}
            />
          </DisclosureButton>
          {/* Stays mounted while closed so the form still submits it. */}
          <DisclosurePanel static className={open ? 'px-4 pb-4' : 'hidden'}>
            {children}
          </DisclosurePanel>
        </>
      )}
    </Disclosure>
  );
};

export default AdvancedSection;
