// Kept apart from the hook, with nothing that needs the page around it, so
// it can be tested on its own.
import { isAxiosError } from 'axios';
import type { IntlShape } from 'react-intl';
import defineMessages from './defineMessages';

/** The AI features' refusals, by the code the server sends with them. */
const messages = defineMessages('utils.aiErrorMessage', {
  off: 'This AI feature is turned off.',
  limit:
    'You have used all {limit} of today’s AI answers. More are available tomorrow.',
  empty: 'The model gave an empty answer. Try again.',
  unreadable:
    'The model’s answer couldn’t be read. Try again, or choose a stronger model.',
  picture: 'That picture could not be read.',
  pictureTooBig: 'That picture is too big.',
  askSomething: 'Ask something, or send a picture.',
  noPictures:
    'This AI model can’t read pictures. An admin can choose one that can in AI settings.',
  outOfCredit:
    'The AI account is out of credit. AI features work again once more is added.',
  busy: 'The AI service is busy right now. Try again shortly.',
  timeout: 'The AI service took too long to answer. Try again.',
  noHistory: 'There is no watch history to explain these by.',
  nobodyHistory: 'Nobody chosen has any watch history to pick from yet.',
  nothingInLibrary:
    'Nothing in the library matches yet. Try including titles not in the library.',
  nothingToPick: 'There is nothing to pick from yet.',
  nothingToRecap: 'There is nothing before this episode to recap.',
  noSummaries: 'TMDB has no episode summaries for this series.',
  issueNotFound: 'Issue not found.',
});

const isCode = (code: unknown): code is keyof typeof messages =>
  typeof code === 'string' && Object.hasOwn(messages, code);

/**
 * The server's reason, which is always written to be shown: in the
 * person's language when it comes with a code this page knows (and `intl`
 * is given), otherwise the server's English. `failed` is the fallback's.
 */
export const aiErrorMessage = (
  e: unknown,
  fallback: string,
  intl?: IntlShape
): string => {
  const data = isAxiosError(e)
    ? (e.response?.data as
        | {
            message?: string;
            code?: string;
            values?: Record<string, string | number>;
          }
        | undefined)
    : undefined;
  if (intl && data?.code === 'failed') {
    return fallback;
  }
  if (intl && isCode(data?.code)) {
    return intl.formatMessage(messages[data.code], data.values);
  }
  return data?.message || fallback;
};

export default aiErrorMessage;
