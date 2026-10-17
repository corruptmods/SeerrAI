import Button from '@app/components/Common/Button';
import { formatDay, seasonName } from '@app/components/Seasonal/messages';
import { SeasonIcon } from '@app/components/Seasonal/SeasonMark';
import { useNotice } from '@app/context/NoticeQueue';
import { useTheme } from '@app/context/ThemeContext';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import type { SeasonChoice } from '@server/lib/seasons';
import { noteChoice } from '@server/lib/seasons';
import axios from 'axios';
import Link from 'next/link';
import { useId, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Seasonal.SeasonalNote', {
  title: '{season} theme, until {date}',
  body: 'It sits on top of your own theme and goes away by itself.',
  forGood:
    'You can turn seasonal themes off for good in <link>Appearance settings</link>.',
  keep: 'Keep',
  turnOff: 'Turn off',
  failed: 'Your answer could not be saved.',
});

/**
 * The first time someone sees a season, a note says what it is and until
 * when, with Keep and Turn off. Turn off is for this season only, until it
 * ends; seasonal themes are switched off for good in Appearance settings.
 * Their answer is kept with their account, so no other device asks again.
 * A banner above the page on a computer, a sheet above the bottom bar on a
 * phone. It waits its turn behind other notices (NoticeQueue).
 */
const SeasonalNote = () => {
  const intl = useIntl();
  const titleId = useId();
  const { addToast } = useToasts();
  const { user, revalidate } = useUser();
  const { season, current } = useTheme();
  // Answered on this page: gone at once, before the account says so.
  const [answered, setAnswered] = useState<string>();

  const due =
    !!user &&
    !!current &&
    season === current.id &&
    !noteChoice(current, user.settings?.seasonNote) &&
    answered !== current.key;
  const myTurn = useNotice('seasonal', due ? 'show' : 'hide');

  if (!myTurn || !current || !user) {
    return null;
  }

  const answer = async (choice: SeasonChoice) => {
    setAnswered(current.key);
    try {
      const response = await axios.post<{ seasonNote: string }>(
        `/api/v1/user/${user.id}/settings/appearance/season`,
        { season: current.key, choice }
      );
      // Turning it off takes the season away at once.
      if (user.settings) {
        await revalidate(
          {
            ...user,
            settings: {
              ...user.settings,
              seasonNote: response.data.seasonNote,
            },
          },
          false
        );
      } else {
        await revalidate();
      }
    } catch {
      setAnswered(undefined);
      addToast(intl.formatMessage(messages.failed), {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };

  return (
    <Transition
      show
      appear
      as="section"
      aria-labelledby={titleId}
      enter="motion-safe:transition motion-safe:duration-300"
      enterFrom="motion-safe:translate-y-4 opacity-0"
      enterTo="translate-y-0 opacity-100"
      // A sheet above the bottom bar on a phone (over Discover's customize
      // button, which shares the spot), and above safe mode's note when
      // that is showing there too; in the page from tablets up.
      className="absolute-bottom-shift fixed inset-x-3 z-[51] sm:static sm:z-auto sm:mb-4 [[data-safe=on]_&]:bottom-[calc(9.5rem+env(safe-area-inset-bottom))]"
    >
      <div className="flex flex-col gap-3 rounded-xl border border-accent bg-surface p-4 shadow-xl sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4 sm:rounded-lg sm:bg-accent/10 sm:shadow-none">
        <div className="flex min-w-0 items-start gap-3 sm:flex-1 sm:items-center">
          <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-surface-raised sm:h-auto sm:w-auto sm:bg-transparent">
            <SeasonIcon season={current.id} className="h-6 w-6" />
          </span>
          <div className="min-w-0">
            <p id={titleId} className="font-semibold text-strong">
              {intl.formatMessage(messages.title, {
                season: seasonName(intl, current.id),
                date: formatDay(intl, current.end),
              })}
            </p>
            <p className="text-sm text-default">
              {intl.formatMessage(messages.body)}
            </p>
          </div>
        </div>
        <div className="flex gap-2.5 sm:flex-none">
          <Button
            buttonType="primary"
            className="flex-1 justify-center sm:flex-none"
            onClick={() => answer('keep')}
          >
            {intl.formatMessage(messages.keep)}
          </Button>
          <Button
            className="flex-1 justify-center sm:flex-none"
            onClick={() => answer('off')}
          >
            {intl.formatMessage(messages.turnOff)}
          </Button>
        </div>
        <p className="text-xs text-muted sm:basis-full">
          {intl.formatMessage(messages.forGood, {
            link: (chunks: React.ReactNode) => (
              <Link
                href="/profile/settings/appearance"
                className="font-semibold text-accent-text underline-offset-2 hover:underline"
              >
                {chunks}
              </Link>
            ),
          })}
        </p>
      </div>
    </Transition>
  );
};

export default SeasonalNote;
