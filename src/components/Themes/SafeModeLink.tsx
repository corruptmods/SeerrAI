import Button from '@app/components/Common/Button';
import defineMessages from '@app/utils/defineMessages';
import {
  isSafeMode,
  safeModeHref,
  turnOffSafeMode,
} from '@app/utils/theme/safeMode';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Themes.SafeModeLink', {
  somethingBroken:
    'Something look broken? <link>Open Seerr AI without custom CSS</link>. The sign-in page has the same link.',
  safeModeOn:
    'Safe mode is on in this tab: no custom CSS or theme files are used.',
  turnOff: 'Turn Off Safe Mode',
});

/**
 * Where custom CSS is set: a way into safe mode (this page without custom
 * CSS or theme files), or out of it when it is on. A plain link, so the
 * page loads again from scratch.
 */
const SafeModeLink = () => {
  const intl = useIntl();
  const router = useRouter();
  const [safe, setSafe] = useState(false);
  useEffect(() => setSafe(isSafeMode()), []);

  if (safe) {
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
        <span>{intl.formatMessage(messages.safeModeOn)}</span>
        <Button type="button" buttonSize="sm" onClick={turnOffSafeMode}>
          {intl.formatMessage(messages.turnOff)}
        </Button>
      </div>
    );
  }
  return (
    <p className="text-sm text-muted">
      {intl.formatMessage(messages.somethingBroken, {
        link: (text) => (
          <a
            href={safeModeHref(router.asPath)}
            className="font-semibold text-accent-text hover:underline"
          >
            {text}
          </a>
        ),
      })}
    </p>
  );
};

export default SafeModeLink;
