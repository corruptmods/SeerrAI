import VoiceInputButton, {
  useVoiceInput,
} from '@app/components/Common/VoiceInput';
import useFeature from '@app/hooks/useFeature';
import useMediaQuery from '@app/hooks/useMediaQuery';
import useSearchInput from '@app/hooks/useSearchInput';
import defineMessages from '@app/utils/defineMessages';
import { XCircleIcon } from '@heroicons/react/24/outline';
import { MagnifyingGlassIcon } from '@heroicons/react/24/solid';
import { useCallback, useRef } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Layout.SearchInput', {
  searchPlaceholder: 'Search Movies & Series',
  searchPlaceholderMusic: 'Search Movies, Series & Music',
  searchPlaceholderShort: 'Search',
  clearSearch: 'Clear Search',
});

const SearchInput = () => {
  const intl = useIntl();
  const { searchValue, setSearchValue, setIsOpen, clear } = useSearchInput();
  const musicOn = useFeature('music');
  // The full hint does not fit beside the header's buttons on a phone;
  // the label says it all to a screen reader at any width.
  const wide = useMediaQuery('(min-width: 640px)');
  const fullHint = intl.formatMessage(
    musicOn ? messages.searchPlaceholderMusic : messages.searchPlaceholder
  );
  const field = useRef<HTMLInputElement>(null);
  // Searches as the words come, as typing does.
  const voice = useVoiceInput(
    useCallback(
      (text: string) => {
        if (text) {
          setIsOpen(true);
          setSearchValue(text);
        }
      },
      [setIsOpen, setSearchValue]
    )
  );
  const hasText = searchValue.length > 0;
  return (
    <div className="flex flex-1" data-seerr="search">
      <div className="flex w-full">
        <label htmlFor="search_field" className="sr-only">
          {fullHint}
        </label>
        <div className="relative flex w-full items-center text-strong focus-within:text-gray-200">
          <div className="pointer-events-none absolute inset-y-0 left-4 flex items-center">
            <MagnifyingGlassIcon className="h-5 w-5" />
          </div>
          <input
            ref={field}
            id="search_field"
            style={{
              paddingRight:
                hasText && voice.available
                  ? '4rem'
                  : hasText || voice.available
                    ? '2.25rem'
                    : '',
            }}
            className="block w-full rounded-full border border-strong bg-page/panel py-2 pl-10 text-strong placeholder-gray-300 hover:border-gray-500 focus:border-gray-500 focus:bg-page focus:placeholder-gray-400 focus:outline-none focus:ring-0 sm:text-base"
            placeholder={
              wide
                ? fullHint
                : intl.formatMessage(messages.searchPlaceholderShort)
            }
            type="search"
            autoComplete="off"
            value={searchValue}
            onChange={(e) => setSearchValue(e.target.value)}
            onFocus={() => setIsOpen(true)}
            onBlur={() => {
              if (searchValue === '') {
                setIsOpen(false);
              }
            }}
            onKeyUp={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
          <div className="absolute inset-y-0 right-2 flex items-center">
            {hasText && (
              <button
                className="m-auto h-7 w-7 border-none p-1 text-muted outline-none transition hover:text-strong focus:border-none focus:outline-none"
                onClick={() => clear()}
                aria-label={intl.formatMessage(messages.clearSearch)}
              >
                <XCircleIcon className="h-5 w-5" />
              </button>
            )}
            {voice.available && (
              <VoiceInputButton
                className="h-7 w-7"
                listening={voice.listening}
                onToggle={() => {
                  if (!voice.listening) {
                    field.current?.focus();
                  }
                  voice.toggle();
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SearchInput;
