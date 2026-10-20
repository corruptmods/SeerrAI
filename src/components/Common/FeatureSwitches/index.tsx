import { shownFeatures } from '@app/components/Common/FeatureSwitches/shown';
import defineMessages from '@app/utils/defineMessages';
import type { Feature } from '@server/constants/features';
import { FEATURES, isAiFeature } from '@server/constants/features';
import type { ReactNode } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Common.FeatureSwitches', {
  suggestedForYou: 'Suggested for You',
  suggestedForYouTip: 'A Discover row and page picked from what you’ve watched',
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
    'A series page button that requests each new season as it premieres. Off pauses followed series',
  watchSuggestions: 'Finished Watching?',
  watchSuggestionsTip:
    'Offers to remove titles from a watch list once everyone on it has watched them',
  passkeyPrompt: 'Passkey Reminder',
  passkeyPromptTip:
    'The banner asking to add a passkey. Signing in with passkeys is unaffected',
  subtitles: 'Subtitles',
  subtitlesTip: 'Subtitles on title pages and episodes, from Bazarr',
  autoFix: 'Fix Reported Problems',
  autoFixTip:
    'Fixes reported issues right away: subtitles, missing episodes, broken or wrong files. Comments with what it did',
  music: 'Music',
  musicTip:
    'Music in search, Discover and its own pages, and requesting albums through Lidarr',
  offForEveryone: 'Turned off for everyone by an admin',
  ai: 'AI',
  aiDescription:
    'Use the AI model from Settings → AI. Each sends only what it needs.',
  aiNotSetUp: 'Set up a model in Settings → AI to use these.',
  aiChat: 'AI Search',
  aiChatTip:
    'The AI button by the search box: describe what you want. Sends your message and recently watched titles',
  aiReasons: 'Why These Suggestions',
  aiReasonsTip:
    'Says why each title is on Suggested for You. Sends your recent watches and the suggestions',
  aiPicker: 'Pick for the Room',
  aiPickerTip:
    'Picks three titles for a group. Off leaves you out of others’ picks. Sends recent watches, never names',
  aiRecap: 'Catch Me Up',
  aiRecapTip:
    'A spoiler-free recap on series pages, up to where you are. Sends episode summaries',
  aiDeletionReview: 'Review Deletions',
  aiDeletionReviewTip:
    'Flags Maintainerr deletions that may be a mistake (request managers). Sends titles and view counts, never names',
  aiIssueTriage: 'Suggest Issue Fixes',
  aiIssueTriageTip:
    'Likely cause and fix on each issue (issue managers). Sends the issue and comments',
  aiLogs: 'Explain Logs',
  aiLogsTip:
    'Explains log entries in plain English (admins). Keys, tokens and emails are removed first',
  aiBackfill: 'Backfill Second Opinion',
  aiBackfillTip:
    'Places pack files with unclear names, for an admin to check. Sends the series, episode titles and file names',
  aiAgent: 'Admin Agent',
  aiAgentTip:
    'Finds what Backfill can’t, on its own or when an admin asks. Sends titles, episode lists and release names',
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
