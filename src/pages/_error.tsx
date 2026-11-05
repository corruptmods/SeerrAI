import PageTitle from '@app/components/Common/PageTitle';
import defineMessages from '@app/utils/defineMessages';

import { ArrowRightCircleIcon } from '@heroicons/react/24/outline';
import type { NextPage } from 'next';
import Link from 'next/link';
import { useIntl } from 'react-intl';

interface ErrorProps {
  statusCode?: number;
  /** The error, for client-side failures only. */
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
  const statusCode = res ? res.statusCode : err?.statusCode;

  // Client-side errors show their message so they can be reported (an
  // installed phone app has no console). Server errors are never shown.
  const detail =
    !res && err?.message
      ? `${err.name}: ${err.message}`.slice(0, 300)
      : undefined;

  return { statusCode, ...(detail ? { detail } : {}) };
};

export default ErrorPage;
