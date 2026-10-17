import Button from '@app/components/Common/Button';
import useLazyModule, { preloadModule } from '@app/hooks/useLazyModule';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { ArrowUpTrayIcon } from '@heroicons/react/24/outline';
import type { Appearance } from '@server/constants/theme';
import type { ThemeFile } from '@server/constants/themeFile';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Themes.ImportThemeButton', {
  importTheme: 'Import a Theme',
  couldNotOpen: 'The theme importer couldn’t be opened. Try again.',
});

const loadImport = () => import('@app/components/Themes/ImportThemeModal');

/**
 * Import a Theme: a button that opens the importer (loaded when first
 * wanted), which shows the file before handing it to `onApply`.
 */
const ImportThemeButton = ({
  base,
  onApply,
}: {
  base: Appearance;
  onApply: (theme: ThemeFile) => void;
}) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [open, setOpen] = useState(false);

  useEffect(() => preloadModule(loadImport), []);
  const importer = useLazyModule(loadImport, open, () => {
    addToast(intl.formatMessage(messages.couldNotOpen), {
      appearance: 'error',
      autoDismiss: true,
    });
    setOpen(false);
  });

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        <ArrowUpTrayIcon />
        <span>{intl.formatMessage(messages.importTheme)}</span>
      </Button>
      <Transition
        as="div"
        show={open}
        enter="transition-opacity duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity duration-300"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
      >
        {importer && (
          <importer.default
            base={base}
            onCancel={() => setOpen(false)}
            onApply={(theme) => {
              setOpen(false);
              onApply(theme);
            }}
          />
        )}
      </Transition>
    </>
  );
};

export default ImportThemeButton;
