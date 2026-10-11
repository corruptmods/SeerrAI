import { useAiAnswer } from '@app/components/Ai/AiPanel';
import Button from '@app/components/Common/Button';
import useAi from '@app/hooks/useAi';
import defineMessages from '@app/utils/defineMessages';
import { SparklesIcon } from '@heroicons/react/24/outline';
import type { LogMessage } from '@server/interfaces/api/settingsInterfaces';
import axios from 'axios';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Ai.LogExplain', {
  explain: 'Explain',
  explanation: 'What this means',
  thinking: 'Thinking…',
  sentNote: 'Keys, tokens and emails are removed before anything is sent.',
});

/** A log entry in plain English, with what to check. */
const LogExplain = ({ log }: { log: LogMessage }) => {
  const intl = useIntl();
  const { on } = useAi();
  const { busy, answer, error, ask } = useAiAnswer<{ text: string }>();

  if (!on('aiLogs')) {
    return null;
  }

  return (
    <div className="form-row">
      <div className="text-label">
        {intl.formatMessage(messages.explanation)}
      </div>
      <div className="form-input-area space-y-2 text-sm">
        {!answer && (
          <>
            <Button
              buttonType="default"
              buttonSize="sm"
              disabled={busy}
              onClick={() =>
                ask(async () => {
                  const response = await axios.post<{ text: string }>(
                    '/api/v1/ai/explain-log',
                    {
                      label: log.label,
                      level: log.level,
                      message: log.message,
                      data: log.data,
                    }
                  );
                  return response.data;
                })
              }
            >
              <SparklesIcon />
              <span>
                {intl.formatMessage(
                  busy ? messages.thinking : messages.explain
                )}
              </span>
            </Button>
            <p className="text-xs text-gray-400">
              {intl.formatMessage(messages.sentNote)}
            </p>
          </>
        )}
        {error && (
          <p className="text-red-300" role="alert">
            {error}
          </p>
        )}
        {answer && (
          <p className="whitespace-pre-line text-gray-200">{answer.text}</p>
        )}
      </div>
    </div>
  );
};

export default LogExplain;
