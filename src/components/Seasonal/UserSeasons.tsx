import Button from '@app/components/Common/Button';
import SlideCheckbox from '@app/components/Common/SlideCheckbox';
import {
  formatDates,
  formatDay,
  seasonName,
} from '@app/components/Seasonal/messages';
import { SeasonIcon } from '@app/components/Seasonal/SeasonMark';
import { useTheme } from '@app/context/ThemeContext';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { SEASON_LOOKS } from '@app/utils/theme/seasons';
import { noteChoice, upcomingDates } from '@server/lib/seasons';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Seasonal.UserSeasons', {
  seasonal: 'Seasonal themes',
  seasonalSwitch: 'Show seasonal themes',
  description:
    'A few days a year, Seerr AI dresses up over your theme, then switches back by itself.',
  none: 'This server has no seasonal themes switched on.',
  showingNow: 'On now, until {date}',
  preview: 'Preview',
  previewSeason: 'Preview {season}',
  stopPreview: 'Stop Preview',
  turnedOff: 'You turned the {season} theme off until {date}.',
  showAgain: 'Show It Again',
  failed: 'Something went wrong while saving.',
});

/**
 * The Seasonal themes part of Profile → Settings → Appearance: the switch,
 * and the seasons this server runs with their next dates. On one's own
 * page each can be previewed on top of the look being chosen; a season
 * turned off from its note can be brought back.
 */
const UserSeasons = ({
  seasonal,
  onToggle,
  isOwn,
}: {
  seasonal: boolean;
  onToggle: () => void;
  /** Their own page: previews show on their screen. */
  isOwn: boolean;
}) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { currentSettings } = useSettings();
  const { season, current, today, setSeasonPreview } = useTheme();
  const { user, revalidate } = useUser();
  const [saving, setSaving] = useState(false);
  const calendar = currentSettings.seasons ?? [];

  const turnedOff =
    isOwn &&
    seasonal &&
    current &&
    noteChoice(current, user?.settings?.seasonNote) === 'off'
      ? current
      : undefined;

  const showAgain = async () => {
    if (!user || !turnedOff) {
      return;
    }
    setSaving(true);
    try {
      await axios.post(`/api/v1/user/${user.id}/settings/appearance/season`, {
        season: turnedOff.key,
        choice: 'keep',
      });
      await revalidate();
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
      aria-labelledby="appearance-seasonal"
      className="flex flex-col gap-3"
    >
      <div className="flex items-center justify-between gap-4">
        <h2
          id="appearance-seasonal"
          className="text-lg font-semibold text-strong"
        >
          {intl.formatMessage(messages.seasonal)}
        </h2>
        <SlideCheckbox
          checked={seasonal}
          onClick={onToggle}
          label={intl.formatMessage(messages.seasonalSwitch)}
        />
      </div>
      <p className="text-sm text-muted">
        {intl.formatMessage(messages.description)}
      </p>
      {turnedOff && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-subtle bg-surface px-4 py-3 text-sm text-default">
          <span>
            {intl.formatMessage(messages.turnedOff, {
              season: seasonName(intl, turnedOff.id),
              date: formatDay(intl, turnedOff.end),
            })}
          </span>
          <Button
            type="button"
            buttonSize="sm"
            disabled={saving}
            onClick={showAgain}
          >
            {intl.formatMessage(messages.showAgain)}
          </Button>
        </div>
      )}
      {calendar.length === 0 ? (
        <p className="text-sm text-muted">
          {intl.formatMessage(messages.none)}
        </p>
      ) : (
        <ul
          className={`overflow-hidden rounded-xl border border-subtle motion-safe:transition-opacity ${
            seasonal ? '' : 'opacity-60'
          }`}
        >
          {calendar.map((entry) => {
            const dates = upcomingDates(entry, today);
            const look = SEASON_LOOKS[entry.id];
            const previewing = isOwn && season === entry.id;
            return (
              <li
                key={entry.id}
                className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-t border-subtle bg-surface px-4 py-3.5 first:border-t-0"
              >
                <span
                  aria-hidden="true"
                  className="flex h-9 w-9 flex-none items-center justify-center rounded-full"
                  style={{ backgroundColor: look.night.surfaceRaised }}
                >
                  <SeasonIcon
                    season={entry.id}
                    colour={look.mark.dark}
                    className="h-5 w-5"
                  />
                </span>
                <div className="min-w-0 flex-[1_1_10rem]">
                  <div className="font-semibold text-strong">
                    {seasonName(intl, entry.id)}
                  </div>
                  {dates && (
                    <div className="text-sm text-muted">
                      {current?.id === entry.id
                        ? intl.formatMessage(messages.showingNow, {
                            date: formatDay(intl, current.end),
                          })
                        : formatDates(intl, dates)}
                    </div>
                  )}
                </div>
                {isOwn && (
                  <Button
                    type="button"
                    buttonSize="sm"
                    aria-pressed={previewing}
                    aria-label={
                      previewing
                        ? undefined
                        : intl.formatMessage(messages.previewSeason, {
                            season: seasonName(intl, entry.id),
                          })
                    }
                    onClick={() =>
                      setSeasonPreview(previewing ? null : entry.id)
                    }
                  >
                    {intl.formatMessage(
                      previewing ? messages.stopPreview : messages.preview
                    )}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

export default UserSeasons;
