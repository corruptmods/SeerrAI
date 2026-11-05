import Button from '@app/components/Common/Button';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { ArrowPathIcon } from '@heroicons/react/24/outline';
import axios from 'axios';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Music.MusicUnavailable', {
  busy: 'MusicBrainz is busy right now. Try again in a moment.',
  failed: 'MusicBrainz did not answer.',
  tryAgain: 'Try Again',
});

/**
 * A music page's error. MusicBrainz allows one request a second per server,
 * so "busy" is common and offers a retry; missing, or music off, is a 404.
 */
const MusicUnavailable = ({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) => {
  const intl = useIntl();
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;

  if (status === 404 || status === 403 || status === 400) {
    return <ErrorPage statusCode={404} />;
  }

  return (
    <div className="mt-16 flex flex-col items-center gap-4 text-center text-default">
      <p>
        {intl.formatMessage(status === 503 ? messages.busy : messages.failed)}
      </p>
      <Button buttonType="primary" onClick={onRetry}>
        <ArrowPathIcon />
        <span>{intl.formatMessage(messages.tryAgain)}</span>
      </Button>
    </div>
  );
};

export default MusicUnavailable;
