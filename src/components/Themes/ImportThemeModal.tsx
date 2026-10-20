import Alert from '@app/components/Common/Alert';
import Modal from '@app/components/Common/Modal';
import LookSwatch from '@app/components/Themes/LookSwatch';
import defineMessages from '@app/utils/defineMessages';
import {
  appearanceWithThemeFile,
  hardToRead,
} from '@app/utils/theme/themeFile';
import type { Appearance } from '@server/constants/theme';
import type { ThemeFile, ThemeFileProblem } from '@server/constants/themeFile';
import {
  THEME_FILE_MAX_BYTES,
  readThemeFile,
} from '@server/constants/themeFile';
import { useId, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Themes.ImportThemeModal', {
  title: 'Import a Theme',
  description:
    'A theme file holds colours and a few settings, nothing else. You’ll see it here before it’s used.',
  chooseFile: 'Theme file',
  orPaste: 'Or paste it here',
  apply: 'Use This Theme',
  by: 'by {author}',
  dark: 'Dark',
  light: 'Light',
  hardToRead:
    'Some text in this theme may be hard to read. Use the Server’s Default to go back.',
  tooLarge: 'This file is too large to be a theme file (16 KB at most).',
  notJson: 'This isn’t a theme file: it isn’t JSON.',
  notThemeFile: 'This isn’t a Seerr AI theme file.',
  newerVersion:
    'This theme file is for a newer version of Seerr AI than this one.',
  name: 'This theme file needs a name of up to 60 characters.',
  unknownKey: '“{key}” isn’t something a theme file can hold.',
  notColour: '“{key}” has to be a colour, such as #1c1917.',
  notValue: '“{key}” has a value it can’t have.',
  unreadable: 'This file couldn’t be read.',
});

const problemText = (
  intl: ReturnType<typeof useIntl>,
  problem: ThemeFileProblem
): string =>
  'key' in problem
    ? intl.formatMessage(messages[problem.problem], { key: problem.key })
    : intl.formatMessage(messages[problem.problem]);

/**
 * Import a theme file: choose the file (or paste it), see what it looks
 * like, then use it. Using it puts it into the form being edited; it is
 * kept when that is saved. Loaded only when someone asks to import.
 */
const ImportThemeModal = ({
  base,
  onCancel,
  onApply,
}: {
  /** The look it would be used with, for the preview. */
  base: Appearance;
  onCancel: () => void;
  onApply: (theme: ThemeFile) => void;
}) => {
  const intl = useIntl();
  const fileId = useId();
  const pasteId = useId();
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();

  const read = text.trim() ? readThemeFile(text) : undefined;
  const theme = read && 'theme' in read ? read.theme : undefined;
  const problem =
    error ??
    (read && !theme ? problemText(intl, read as ThemeFileProblem) : undefined);
  const look = theme ? appearanceWithThemeFile(base, theme) : undefined;

  const chooseFile = async (file: File | undefined) => {
    setError(undefined);
    if (!file) {
      return;
    }
    if (file.size > THEME_FILE_MAX_BYTES) {
      setText('');
      setError(intl.formatMessage(messages.tooLarge));
      return;
    }
    try {
      setText(await file.text());
    } catch {
      setText('');
      setError(intl.formatMessage(messages.unreadable));
    }
  };

  return (
    <Modal
      title={intl.formatMessage(messages.title)}
      onCancel={onCancel}
      onOk={() => theme && onApply(theme)}
      okText={intl.formatMessage(messages.apply)}
      okDisabled={!theme}
      backgroundClickable={!text}
      showCloseButton
    >
      <div className="flex flex-col gap-4" data-seerr="theme-import">
        <p className="text-sm text-muted">
          {intl.formatMessage(messages.description)}
        </p>
        <div>
          <label htmlFor={fileId}>
            {intl.formatMessage(messages.chooseFile)}
          </label>
          <input
            id={fileId}
            type="file"
            accept=".json,application/json"
            onChange={(e) => chooseFile(e.target.files?.[0])}
            className="block w-full text-sm text-default file:mr-3 file:rounded-md file:border-0 file:bg-surface-raised file:px-3 file:py-2 file:text-sm file:font-semibold file:text-strong hover:file:bg-gray-600"
          />
        </div>
        <div>
          <label htmlFor={pasteId}>
            {intl.formatMessage(messages.orPaste)}
          </label>
          <textarea
            id={pasteId}
            rows={4}
            value={text}
            onChange={(e) => {
              setError(undefined);
              setText(e.target.value);
            }}
            spellCheck={false}
            autoComplete="off"
            className="font-mono text-xs"
            placeholder={'{ "seerrTheme": 1, "name": "…" }'}
          />
        </div>
        {problem && (
          <p className="text-sm text-danger-text" role="alert">
            {problem}
          </p>
        )}
        {theme && look && (
          <div className="flex flex-col gap-3" aria-live="polite">
            <div>
              <span className="font-semibold text-strong">{theme.name}</span>
              {theme.author && (
                <span className="ml-2 text-sm text-muted">
                  {intl.formatMessage(messages.by, { author: theme.author })}
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              {(['dark', 'light'] as const).map((mode) => (
                <div key={mode} className="flex flex-col gap-1">
                  <LookSwatch look={look} mode={mode} className="h-20" />
                  <span className="text-xs font-medium text-muted">
                    {intl.formatMessage(messages[mode])}
                  </span>
                </div>
              ))}
            </div>
            {hardToRead(look).length > 0 && (
              <Alert
                type="warning"
                title={intl.formatMessage(messages.hardToRead)}
              />
            )}
          </div>
        )}
      </div>
    </Modal>
  );
};

export default ImportThemeModal;
