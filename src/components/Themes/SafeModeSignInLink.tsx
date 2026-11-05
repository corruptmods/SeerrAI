import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import { isSafeMode, safeModeHref } from '@app/utils/theme/safeMode';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Themes.SafeModeSignInLink', {
  openSafe: 'Page look broken? Open it without custom CSS',
});

/**
 * Sign-in page link into safe mode while Server CSS or a default theme file
 * is set, in case they break the page. A plain link so the page fully reloads.
 */
const SafeModeSignInLink = () => {
  const intl = useIntl();
  const router = useRouter();
  const { currentSettings } = useSettings();
  const [safe, setSafe] = useState(false);
  useEffect(() => setSafe(isSafeMode()), []);

  if (
    safe ||
    (!currentSettings.customCss.server && !currentSettings.themeDefault.theme)
  ) {
    return null;
  }
  return (
    <p className="mt-6 text-center text-xs text-muted">
      <a
        href={safeModeHref(router.asPath)}
        className="underline-offset-2 hover:text-strong hover:underline"
        data-seerr="safe-mode-link"
      >
        {intl.formatMessage(messages.openSafe)}
      </a>
    </p>
  );
};

export default SafeModeSignInLink;
