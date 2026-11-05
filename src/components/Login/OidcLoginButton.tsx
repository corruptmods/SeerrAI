import Button from '@app/components/Common/Button';
import { SmallLoadingSpinner } from '@app/components/Common/LoadingSpinner';
import { OPTION_BUTTON } from '@app/components/Login/signInOptions';
import messages from '@app/components/Login/singleSignOnMessages';
import { KeyIcon } from '@heroicons/react/24/outline';
import { oidcApplicationUrl } from '@server/constants/oidc';
import { useState } from 'react';
import { useIntl } from 'react-intl';

interface OidcLoginButtonProps {
  provider: { id: string; name: string; logoUrl: string };
  applicationUrl: string;
  /** Same-site path to go to after signing in. */
  redirect: string;
  /** Show just the provider name; the full label stays as the aria-label. */
  compact?: boolean;
}

/**
 * Link to a provider's sign-in via the Application URL, which the provider
 * redirects back to, so sign-in ends there whatever address started it.
 */
const OidcLoginButton = ({
  provider,
  applicationUrl,
  redirect,
  compact,
}: OidcLoginButtonProps) => {
  const intl = useIntl();
  const signInWith = intl.formatMessage(messages.signInWith, {
    provider: provider.name,
  });
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
      className={`${OPTION_BUTTON} bg-transparent`}
      aria-label={compact ? signInWith : undefined}
      data-testid="oidc-login-button"
    >
      {leaving && (
        <div className="absolute right-0 mr-4 h-4 w-4">
          <SmallLoadingSpinner />
        </div>
      )}
      {provider.logoUrl ? (
        // Admin-chosen logo from any host.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={provider.logoUrl}
          alt=""
          className="mr-2 h-5 w-5 shrink-0 object-contain"
        />
      ) : (
        <KeyIcon />
      )}
      <span className="truncate">{compact ? provider.name : signInWith}</span>
    </Button>
  );
};

export default OidcLoginButton;
