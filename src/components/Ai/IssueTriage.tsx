import { useAiAnswer } from '@app/components/Ai/AiPanel';
import Button from '@app/components/Common/Button';
import useAi from '@app/hooks/useAi';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { SparklesIcon } from '@heroicons/react/24/outline';
import axios from 'axios';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Ai.IssueTriage', {
  suggest: 'Suggest a Fix',
  thinking: 'Thinking…',
  heading: 'Suggested fix',
  caveat: 'From the report and comments only; check before acting on it.',
});

/** The likely cause and fix for a reported problem, for issue managers. */
const IssueTriage = ({ issueId }: { issueId: number }) => {
  const intl = useIntl();
  const { on } = useAi();
  const { hasPermission } = useUser();
  const { busy, answer, error, ask } = useAiAnswer<{ text: string }>();

  if (
    !on('aiIssueTriage') ||
    !hasPermission([Permission.MANAGE_ISSUES, Permission.ADMIN], {
      type: 'or',
    })
  ) {
    return null;
  }

  return (
    <div className="mt-6 space-y-3" data-testid="ai-issue-triage">
      {!answer && (
        <Button
          buttonType="default"
          buttonSize="sm"
          disabled={busy}
          onClick={() =>
            ask(async () => {
              const response = await axios.get<{ text: string }>(
                `/api/v1/ai/issue/${issueId}`
              );
              return response.data;
            })
          }
        >
          <SparklesIcon />
          <span>
            {intl.formatMessage(busy ? messages.thinking : messages.suggest)}
          </span>
        </Button>
      )}
      {error && (
        <div
          className="rounded-lg border border-red-700 bg-red-900/40 px-3 py-2 text-sm text-red-100"
          role="alert"
        >
          {error}
        </div>
      )}
      {answer && (
        <div className="rounded-lg bg-gray-800/60 p-4 text-sm ring-1 ring-indigo-700/60">
          <div className="mb-2 flex items-center gap-2 font-semibold text-indigo-200">
            <SparklesIcon className="h-4 w-4" />
            {intl.formatMessage(messages.heading)}
          </div>
          <p className="whitespace-pre-line text-gray-200">{answer.text}</p>
          <p className="mt-2 text-xs text-gray-400">
            {intl.formatMessage(messages.caveat)}
          </p>
        </div>
      )}
    </div>
  );
};

export default IssueTriage;
