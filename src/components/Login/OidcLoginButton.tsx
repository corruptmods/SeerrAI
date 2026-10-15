import Button from '@app/components/Common/Button';
import { SmallLoadingSpinner } from '@app/components/Common/LoadingSpinner';
import messages from '@app/components/Login/singleSignOnMessages';
import { KeyIcon } from '@heroicons/react/24/outline';
import { oidcApplicationUrl } from '@server/constants/oidc';
import { useState } from 'react';
import { useIntl } from 'react-intl';

interface OidcLoginButtonProps {
  provider: { id: string; name: string; logoUrl: string };
  applicationUrl: string;
  /** Where to go once signed in: a path on this site. */
  redirect: string;
}

/**
 * "Sign in with Authentik": a link to the provider's sign-in, by way of the
 * Application URL, which the provider sends people back to. Followed from
 * any address Seerr is reached at, the sign-in ends there.
 */
const OidcLoginButton = ({
  provider,
  applicationUrl,
  redirect,
}: OidcLoginButtonProps) => {
  const intl = useIntl();
  const [leaving, setLeaving] = useState(false);
  const query =
    redirect && redirect !== '/'
      ? `?redirect=${encodeURIComponent(redirect)}`
      : '';

  return (
    <Button
      as="a"
      href={`${oidcApplicationUrl(applicationUrl)}/api/v1/auth/oidc/${encodeURIComponent(
        provider.id
      )}/sign-in${query}`}
      onClick={() => setLeaving(true)}
      className="relative flex-1 bg-transparent"
      data-testid="oidc-login-button"
    >
      {leaving && (
        <div className="absolute right-0 mr-4 h-4 w-4">
          <SmallLoadingSpinner />
        </div>
      )}
      {provider.logoUrl ? (
        // A picture the admin chose, from wherever it is kept.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={provider.logoUrl}
          alt=""
          className="mr-2 h-5 w-5 object-contain"
        />
      ) : (
        <KeyIcon />
      )}
      <span>
        {intl.formatMessage(messages.signInWith, { provider: provider.name })}
      </span>
    </Button>
  );
};

export default OidcLoginButton;
