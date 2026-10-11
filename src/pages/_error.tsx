import PageTitle from '@app/components/Common/PageTitle';
import defineMessages from '@app/utils/defineMessages';
import type { Undefinable } from '@app/utils/typeHelpers';
import { ArrowRightCircleIcon } from '@heroicons/react/24/outline';
import type { NextPage } from 'next';
import Link from 'next/link';
import { useIntl } from 'react-intl';

interface ErrorProps {
  statusCode?: number;
  /** What went wrong, for a failure in the browser rather than the server. */
  detail?: string;
}

const messages = defineMessages('pages', {
  errormessagewithcode: '{statusCode} - {error}',
  internalservererror: 'Internal Server Error',
  serviceunavailable: 'Service Unavailable',
  somethingwentwrong: 'Something Went Wrong',
  oops: 'Oops',
  returnHome: 'Return Home',
});

const ErrorPage: NextPage<ErrorProps> = ({ statusCode, detail }) => {
  const intl = useIntl();

  const getErrorMessage = (statusCode?: number) => {
    switch (statusCode) {
      case 500:
        return intl.formatMessage(messages.internalservererror);
      case 503:
        return intl.formatMessage(messages.serviceunavailable);
      default:
        return statusCode
          ? intl.formatMessage(messages.somethingwentwrong)
          : intl.formatMessage(messages.oops);
    }
  };
  return (
    <div className="error-message">
      <PageTitle title={getErrorMessage(statusCode)} />
      <div className="text-4xl">
        {statusCode
          ? intl.formatMessage(messages.errormessagewithcode, {
              statusCode,
              error: getErrorMessage(statusCode),
            })
          : getErrorMessage(statusCode)}
      </div>
      {detail && (
        <p className="mt-2 max-w-full break-words px-4 text-center text-sm text-gray-400">
          {detail}
        </p>
      )}
      <Link href="/" className="mt-2 flex">
        {intl.formatMessage(messages.returnHome)}
        <ArrowRightCircleIcon className="ml-2 h-6 w-6" />
      </Link>
    </div>
  );
};

ErrorPage.getInitialProps = async ({ res, err }): Promise<ErrorProps> => {
  // Apologies for how gross ternary is but this is just temporary. Honestly,
  // blame the nextjs docs
  let statusCode: Undefinable<number>;
  if (res) {
    statusCode = res.statusCode;
  } else {
    statusCode = err ? err.statusCode : undefined;
  }

  // A page that broke in the browser says why, so it can be reported: on a
  // phone, particularly an installed app, there is no console to read it
  // from. Only then: the server's own errors are not the visitor's to read.
  const detail =
    !res && err?.message
      ? `${err.name}: ${err.message}`.slice(0, 300)
      : undefined;

  return { statusCode, ...(detail ? { detail } : {}) };
};

export default ErrorPage;
