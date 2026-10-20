import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import SafeModeLink from '@app/components/Themes/SafeModeLink';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownOnSquareIcon } from '@heroicons/react/24/outline';
import type { PersonalCssProblem } from '@server/constants/customCss';
import { checkPersonalCss } from '@server/constants/customCss';
import axios from 'axios';
import { useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Themes.PersonalCss', {
  personalCss: 'Personal CSS',
  advanced: 'Advanced',
  description:
    'Your own styles, on your screens only. Pictures and fonts must come from this server.',
  placeholder:
    '/* Squarer posters, just for me */\n[data-seerr="title-card"] {\n  border-radius: 4px;\n}',
  saveCss: 'Save CSS',
  saved: 'Your CSS is saved.',
  failed: 'Something went wrong while saving your CSS.',
  tooLarge: 'This is too long: 32 KB at most.',
  notText: 'This isn’t CSS.',
  import:
    '@import can’t be used here: styles can’t be brought in from elsewhere.',
  url: 'Pictures and fonts must come from this server, so {address} can’t be used. Use a path like /my-picture.png.',
  script: '{what} can’t be used: it runs code.',
});

const problemText = (
  intl: ReturnType<typeof useIntl>,
  problem: PersonalCssProblem
): string => {
  switch (problem.problem) {
    case 'url':
      return intl.formatMessage(messages.url, { address: problem.detail });
    case 'script':
      return intl.formatMessage(messages.script, { what: problem.detail });
    default:
      return intl.formatMessage(messages[problem.problem]);
  }
};

/**
 * Profile → Settings → Appearance → Personal CSS: a person's own styles,
 * shown while an admin lets people add their own. It is checked as it is
 * typed, with the same check the server makes. Saved on its own, apart
 * from the rest of the look. The way into safe mode is always shown.
 */
const PersonalCss = ({ userId, isOwn }: { userId: number; isOwn: boolean }) => {
  const intl = useIntl();
  const id = useId();
  const { addToast } = useToasts();
  const { revalidate } = useUser();
  const key = `/api/v1/user/${userId}/settings/css`;
  const { data, mutate } = useSWR<{ css: string; allowed: boolean }>(key);
  const [css, setCss] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) {
      setCss(data.css);
    }
  }, [data]);

  const checked = checkPersonalCss(css);
  const problem = 'css' in checked ? undefined : problemText(intl, checked);
  const changed = !!data && ('css' in checked ? checked.css : css) !== data.css;

  const save = async () => {
    setSaving(true);
    try {
      const response = await axios.post<{ css: string; allowed: boolean }>(
        key,
        { css }
      );
      await mutate(response.data, { revalidate: false });
      setCss(response.data.css);
      // Pages load it by the version the signed-in person carries.
      if (isOwn) {
        await revalidate();
      }
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

  if (!data?.allowed && !isOwn) {
    return null;
  }

  return (
    <section
      aria-labelledby={data?.allowed ? `${id}-heading` : undefined}
      className="mt-10 flex flex-col gap-3 border-t border-subtle pt-8"
      data-seerr="setting-section"
    >
      {data?.allowed && (
        <>
          <h2
            id={`${id}-heading`}
            className="flex items-center gap-2 text-lg font-semibold text-strong"
          >
            {intl.formatMessage(messages.personalCss)}
            <Badge>{intl.formatMessage(messages.advanced)}</Badge>
          </h2>
          <label htmlFor={`${id}-css`} className="font-normal">
            {intl.formatMessage(messages.description)}
          </label>
          <textarea
            id={`${id}-css`}
            rows={8}
            value={css}
            onChange={(e) => setCss(e.target.value)}
            placeholder={intl.formatMessage(messages.placeholder)}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={!!problem}
            aria-describedby={problem ? `${id}-problem` : undefined}
            className="font-mono text-xs leading-relaxed"
          />
          {problem && (
            <p id={`${id}-problem`} className="text-sm text-danger-text">
              {problem}
            </p>
          )}
          <div className="flex justify-end">
            <Button
              type="button"
              buttonType="primary"
              onClick={save}
              disabled={saving || !!problem || !changed}
            >
              <ArrowDownOnSquareIcon />
              <span>
                {saving
                  ? intl.formatMessage(globalMessages.saving)
                  : intl.formatMessage(messages.saveCss)}
              </span>
            </Button>
          </div>
        </>
      )}
      {isOwn && <SafeModeLink />}
    </section>
  );
};

export default PersonalCss;
