import Button from '@app/components/Common/Button';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownOnSquareIcon } from '@heroicons/react/24/outline';
import { PROJECT_BRANCH, PROJECT_URL } from '@server/constants/project';
import axios, { isAxiosError } from 'axios';
import { useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.Settings.SettingsFeatures.SiriShortcut',
  {
    siriShortcut: 'Siri Shortcut',
    siriShortcutTip:
      'The shortcut people add for “Fix this show”. Make it once with <link>the steps in the guide</link>, share it from the Shortcuts app, and paste its iCloud link here. Everyone’s Siri page offers it.',
    shortcutLink: 'iCloud Link',
    shortcutSaved: 'Siri shortcut link saved.',
    shortcutFailed: 'The link could not be saved.',
  }
);

const GUIDE_URL = `${PROJECT_URL}/blob/${PROJECT_BRANCH}/docs/seerr-ai/siri.md`;

/** The iCloud link to the shortcut, saved on its own. */
const SiriShortcut = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const id = useId();
  const { data, mutate } = useSWR<{ shortcutUrl: string }>(
    '/api/v1/settings/siri'
  );
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (data) setValue(data.shortcutUrl);
  }, [data]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await axios.post<{ shortcutUrl: string }>(
        '/api/v1/settings/siri',
        { shortcutUrl: value.trim() }
      );
      await mutate(res.data, { revalidate: false });
      addToast(intl.formatMessage(messages.shortcutSaved), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch (e) {
      addToast(
        (isAxiosError(e) && e.response?.data?.message) ||
          intl.formatMessage(messages.shortcutFailed),
        { appearance: 'error', autoDismiss: true }
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mt-10" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`} className="heading">
        {intl.formatMessage(messages.siriShortcut)}
      </h3>
      <p className="description">
        {intl.formatMessage(messages.siriShortcutTip, {
          link: (text: React.ReactNode) => (
            <a
              key="link"
              href={GUIDE_URL}
              target="_blank"
              rel="noreferrer"
              className="text-indigo-400 hover:underline light:text-accent-text"
            >
              {text}
            </a>
          ),
        })}
      </p>
      <form
        className="section"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="form-row">
          <label htmlFor={id} className="text-label">
            {intl.formatMessage(messages.shortcutLink)}
          </label>
          <div className="form-input-area">
            <div className="form-input-field">
              <input
                id={id}
                type="url"
                inputMode="url"
                value={value}
                disabled={!data}
                placeholder="https://www.icloud.com/shortcuts/…"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
          </div>
        </div>
        <div className="actions">
          <div className="flex justify-end">
            <Button
              buttonType="primary"
              type="submit"
              disabled={!data || saving || value.trim() === data.shortcutUrl}
            >
              <ArrowDownOnSquareIcon />
              <span>
                {intl.formatMessage(
                  saving ? globalMessages.saving : globalMessages.save
                )}
              </span>
            </Button>
          </div>
        </div>
      </form>
    </section>
  );
};

export default SiriShortcut;
