import { shownFeatures } from '@app/components/Common/FeatureSwitches/shown';
import defineMessages from '@app/utils/defineMessages';
import type { Feature } from '@server/constants/features';
import { FEATURES, isAiFeature } from '@server/constants/features';
import type { ReactNode } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Common.FeatureSwitches', {
  suggestedForYou: 'Suggested for You',
  suggestedForYouTip:
    'A row and page on Discover of titles picked from what you have watched',
  deletingSoon: 'Deleting Soon',
  deletingSoonTip:
    'The row, poster badges and Keep button for titles Maintainerr is about to remove',
  releaseCalendar: 'Release Calendar',
  releaseCalendarTip: 'The calendar of upcoming releases, in the menu',
  arrivalEstimates: 'Arrival Estimates',
  arrivalEstimatesTip:
    'When a request should arrive, on requests and title pages',
  whoWatched: 'Who Watched',
  whoWatchedTip: 'Who has watched a title, on its page (admins only)',
  newSeasons: 'Get New Seasons',
  newSeasonsTip:
    'The series page button that requests each new season as it premieres. Off pauses any series already followed',
  watchSuggestions: 'Finished Watching?',
  watchSuggestionsTip:
    'Offers to remove titles from a watch list once everyone on it has watched them',
  passkeyPrompt: 'Passkey Reminder',
  passkeyPromptTip:
    'The banner asking to add a passkey. Signing in with passkeys is unaffected',
  subtitles: 'Subtitles',
  subtitlesTip:
    'The Subtitles panel on title pages and the subtitle tag on each episode, read from Bazarr',
  autoFix: 'Fix Reported Problems',
  autoFixTip:
    'Acts on a reported issue or an AI Search request at once: finds or transcribes subtitles, searches for missing episodes, replaces a broken or wrong file with another release, and comments on the issue with what it did',
  music: 'Music',
  musicTip:
    'Music in search, Discover and its own pages, and requesting albums through Lidarr',
  offForEveryone: 'Turned off for everyone by an admin',
  ai: 'AI',
  aiDescription:
    'Features that use the AI model set up in Settings → AI. Each sends the model only what that answer needs.',
  aiNotSetUp: 'Set up a model in Settings → AI to use these.',
  aiChat: 'AI Search',
  aiChatTip:
    'The AI button beside the search box: describe a title, or ask for something, and get matches to open or request. Sends your message and titles you recently watched',
  aiReasons: 'Why These Suggestions',
  aiReasonsTip:
    'Explains each title on the Suggested for You page. Sends titles you recently watched and the suggested titles',
  aiPicker: 'Pick for the Room',
  aiPickerTip:
    'Picks three titles a group would enjoy together. Only people you share a watch list with can include you, and off leaves you out. Sends titles each person recently watched, never names',
  aiRecap: 'Catch Me Up',
  aiRecapTip:
    'A spoiler-free recap on series pages, up to where you are. Sends the series’ episode summaries up to that point',
  aiDeletionReview: 'Review Deletions',
  aiDeletionReviewTip:
    'Flags titles Maintainerr is about to delete that may be a mistake (request managers). Sends titles and viewing counts, never names',
  aiIssueTriage: 'Suggest Issue Fixes',
  aiIssueTriageTip:
    'A likely cause and fix on each reported issue (issue managers). Sends the issue and its comments',
  aiLogs: 'Explain Logs',
  aiLogsTip:
    'Explains log entries in plain English (admins). Keys, tokens and emails are removed first',
  aiBackfill: 'Backfill Second Opinion',
  aiBackfillTip:
    'Matches pack files whose names do not say which episode they are, for an admin to check before approving. Sends the series, its episode titles and the file names',
  aiAgent: 'Admin Agent',
  aiAgentTip:
    'Looks further when Backfill finds nothing for a requested title, and finds things when an admin asks, starting downloads within its limits. Sends titles, episode lists and release names',
});

interface FeatureSwitchesProps {
  /** Turned off here. */
  disabled: readonly string[];
  /** Turned off for everyone, so not up to whoever is looking. */
  lockedOff?: readonly string[];
  /** A save in flight: one change at a time. */
  saving?: boolean;
  /** Whether an admin has set up a model for the AI features. */
  aiReady: boolean;
  /**
   * Whether music is there to switch: it only exists once an admin has set
   * up Lidarr, and its switch is left out until then.
   */
  musicReady: boolean;
  /**
   * The admin page lists every feature; someone's own page leaves out the
   * AI section until a model is set up, and tools they cannot use.
   */
  forPerson?: boolean;
  /** Features this person has no use for (admin tools, say). */
  hidden?: readonly Feature[];
  /** Shown where a hidden feature's switch would be: where it went, say. */
  instead?: Partial<Record<Feature, ReactNode>>;
  onChange: (feature: Feature, on: boolean) => void;
}

/** One checkbox per optional feature, in the settings page style. */
const FeatureSwitches = ({
  disabled,
  lockedOff = [],
  saving,
  aiReady,
  musicReady,
  forPerson = false,
  hidden = [],
  instead = {},
  onChange,
}: FeatureSwitchesProps) => {
  const intl = useIntl();

  const row = (feature: Feature, unavailable = false) => {
    const locked = lockedOff.includes(feature);
    const id = `feature-${feature}`;
    return (
      <div className="form-row" key={feature}>
        <label htmlFor={id} className="checkbox-label">
          {intl.formatMessage(messages[feature])}
          <span className="label-tip">
            {intl.formatMessage(
              locked ? messages.offForEveryone : messages[`${feature}Tip`]
            )}
          </span>
        </label>
        <div className="form-input-area">
          <input
            type="checkbox"
            id={id}
            name={id}
            checked={!locked && !disabled.includes(feature)}
            disabled={locked || saving || unavailable}
            onChange={(e) => onChange(feature, e.target.checked)}
          />
        </div>
      </div>
    );
  };

  const visible = shownFeatures(hidden, musicReady);
  const ai = visible.filter(isAiFeature);
  const showAi = ai.length > 0 && (aiReady || !forPerson);

  return (
    <>
      {FEATURES.filter((feature) => !isAiFeature(feature)).map((feature) =>
        visible.includes(feature) ? (
          row(feature)
        ) : instead[feature] ? (
          <div className="form-row" key={feature}>
            {instead[feature]}
          </div>
        ) : null
      )}
      {showAi && (
        <>
          <div className="mb-4 mt-10">
            <h3 className="heading">{intl.formatMessage(messages.ai)}</h3>
            <p className="description">
              {intl.formatMessage(
                aiReady ? messages.aiDescription : messages.aiNotSetUp
              )}
            </p>
          </div>
          {ai.map((feature) => row(feature, !aiReady))}
        </>
      )}
    </>
  );
};

/** The list with one feature switched on or off. */
export const withFeature = (
  disabled: readonly string[],
  feature: Feature,
  on: boolean
): Feature[] =>
  FEATURES.filter((f) => (f === feature ? !on : disabled.includes(f)));

export default FeatureSwitches;
