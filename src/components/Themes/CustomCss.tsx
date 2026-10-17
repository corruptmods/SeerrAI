import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import {
  applyCustomCss,
  customCssLinks,
  isSafeMode,
  turnOffSafeMode,
} from '@app/utils/theme/safeMode';
import { ShieldCheckIcon } from '@heroicons/react/24/outline';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Themes.CustomCss', {
  safeMode: 'Safe mode: no custom CSS or theme files in this tab.',
  turnOff: 'Turn Off',
});

/**
 * Keeps the custom stylesheets on the page in step with the server's
 * settings and the person signed in (the server puts the first ones in
 * the page; see utils/theme/safeMode). In safe mode there are none, and a
 * small note says so, with a way to turn it off.
 */
const CustomCss = () => {
  const intl = useIntl();
  const { currentSettings } = useSettings();
  const { user } = useUser();
  const [safe, setSafe] = useState(false);
  const { server, personal } = customCssLinks(
    currentSettings,
    user?.settings?.personalCssVersion
  );

  useEffect(() => setSafe(isSafeMode()), []);
  useEffect(() => applyCustomCss({ server, personal }), [server, personal]);

  if (!safe) {
    return null;
  }
  return (
    <div
      role="status"
      data-seerr="safe-mode"
      className="fixed bottom-[calc(env(safe-area-inset-bottom)+5rem)] left-1/2 z-[55] flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-full border border-strong bg-surface-raised py-1.5 pl-4 pr-1.5 text-sm text-strong shadow-lg lg:bottom-4"
    >
      <ShieldCheckIcon className="h-5 w-5 flex-none" aria-hidden="true" />
      <span>{intl.formatMessage(messages.safeMode)}</span>
      <button
        type="button"
        onClick={turnOffSafeMode}
        className="flex-none rounded-full bg-accent px-3 py-1 font-semibold text-on-accent hover:bg-accent-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-text"
      >
        {intl.formatMessage(messages.turnOff)}
      </button>
    </div>
  );
};

export default CustomCss;
