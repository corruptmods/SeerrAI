import Button from '@app/components/Common/Button';
import SlideCheckbox from '@app/components/Common/SlideCheckbox';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { safeModeHref } from '@app/utils/theme/safeMode';
import { ArrowDownOnSquareIcon } from '@heroicons/react/24/outline';
import { checkServerCss } from '@server/constants/customCss';
import { PROJECT_BRANCH, PROJECT_URL } from '@server/constants/project';
import axios from 'axios';
import { useRouter } from 'next/router';
import { useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { useSWRConfig } from 'swr';

const messages = defineMessages('components.Themes.ServerCss', {
  serverCss: 'Server CSS',
  description:
    'Your own styles for everyone on this server, the sign-in page included. You can bring in a stylesheet from elsewhere with @import, such as a theme.park theme.',
  placeholder:
    '@import url("https://theme-park.dev/css/base/overseerr/nord.css");\n\n/* Rounder buttons for everyone */\n[data-seerr="button"] {\n  border-radius: 999px;\n}',
  hooksTitle: 'Styles that survive updates',
  hooks:
    'Style the names in the <link>list of style hooks</link>, such as <code>data-seerr="title-card"</code>. Those names stay the same between versions. Anything else may change.',
  safeTitle: 'If a style breaks things',
  safe: 'Add <code>?safe</code> to any address, or use the link on the sign-in page, to open Seerr AI without custom CSS and fix it here. <link>Open this page that way</link>.',
  saveCss: 'Save CSS',
  personalCss: 'Let people add their own CSS',
  personalCssHint:
    'Shows Personal CSS in everyone’s Appearance settings. Theirs only changes their own screens.',
  tooLarge: 'This is too long: 64 KB at most.',
  saved: 'Server CSS saved.',
  failed: 'Something went wrong while saving the Server CSS.',
});

const HOOKS_URL = `${PROJECT_URL}/blob/${PROJECT_BRANCH}/docs/seerr-ai/themes.md#style-hooks`;

interface ServerCssSettings {
  css: string;
  personalCss: boolean;
}

const code = (text: React.ReactNode) => (
  <code className="rounded bg-surface-raised px-1 py-0.5 font-mono text-xs text-strong">
    {text}
  </code>
);

/**
 * Settings → Appearance → Server CSS: styles for everyone, and whether
 * people may add their own. Saved on its own, apart from the default look.
 */
const ServerCss = () => {
  const intl = useIntl();
  const id = useId();
  const { addToast } = useToasts();
  const router = useRouter();
  const { mutate: globalMutate } = useSWRConfig();
  const { data, mutate } = useSWR<ServerCssSettings>(
    '/api/v1/settings/appearance/css'
  );
  const [css, setCss] = useState('');
  const [personalCss, setPersonalCss] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) {
      setCss(data.css);
      setPersonalCss(data.personalCss);
    }
  }, [data]);

  if (!data) {
    return null;
  }

  const tooLarge = !('css' in checkServerCss(css));

  const save = async () => {
    setSaving(true);
    try {
      const response = await axios.post<ServerCssSettings>(
        '/api/v1/settings/appearance/css',
        { css, personalCss }
      );
      await mutate(response.data, { revalidate: false });
      setCss(response.data.css);
      // Pages load it by the version in the public settings.
      await globalMutate('/api/v1/settings/public');
      addToast(intl.formatMessage(messages.saved), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch {
      addToast(intl.formatMessage(messages.failed), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="mt-10 flex max-w-4xl flex-col gap-4"
      data-seerr="setting-section"
    >
      <h4 id={`${id}-heading`} className="text-lg font-semibold text-strong">
        {intl.formatMessage(messages.serverCss)}
      </h4>
      <label htmlFor={`${id}-css`} className="font-normal">
        {intl.formatMessage(messages.description)}
      </label>
      <textarea
        id={`${id}-css`}
        rows={9}
        value={css}
        onChange={(e) => setCss(e.target.value)}
        placeholder={intl.formatMessage(messages.placeholder)}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={tooLarge}
        className="font-mono text-xs leading-relaxed"
      />
      {tooLarge && (
        <p className="text-sm text-danger-text">
          {intl.formatMessage(messages.tooLarge)}
        </p>
      )}
      <div className="grid gap-3 text-sm text-muted sm:grid-cols-2">
        <div className="rounded-lg border border-subtle bg-surface p-3">
          <div className="mb-1 font-semibold text-strong">
            {intl.formatMessage(messages.hooksTitle)}
          </div>
          {intl.formatMessage(messages.hooks, {
            link: (text) => (
              <a
                href={HOOKS_URL}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-accent-text hover:underline"
              >
                {text}
              </a>
            ),
            code,
          })}
        </div>
        <div className="rounded-lg border border-subtle bg-surface p-3">
          <div className="mb-1 font-semibold text-strong">
            {intl.formatMessage(messages.safeTitle)}
          </div>
          {intl.formatMessage(messages.safe, {
            code,
            link: (text) => (
              <a
                href={safeModeHref(router.asPath)}
                className="font-semibold text-accent-text hover:underline"
              >
                {text}
              </a>
            ),
          })}
        </div>
      </div>
      <div className="flex items-center justify-between gap-4 rounded-lg border border-subtle bg-surface p-4">
        <div>
          <div className="font-medium text-strong">
            {intl.formatMessage(messages.personalCss)}
          </div>
          <div className="text-sm text-muted">
            {intl.formatMessage(messages.personalCssHint)}
          </div>
        </div>
        <SlideCheckbox
          checked={personalCss}
          onClick={() => setPersonalCss(!personalCss)}
          label={intl.formatMessage(messages.personalCss)}
        />
      </div>
      <div className="actions">
        <div className="flex justify-end">
          <Button
            type="button"
            buttonType="primary"
            onClick={save}
            disabled={saving || tooLarge}
          >
            <ArrowDownOnSquareIcon />
            <span>
              {saving
                ? intl.formatMessage(globalMessages.saving)
                : intl.formatMessage(messages.saveCss)}
            </span>
          </Button>
        </div>
      </div>
    </section>
  );
};

export default ServerCss;
