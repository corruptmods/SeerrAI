import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import PageTitle from '@app/components/Common/PageTitle';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { LinkIcon } from '@heroicons/react/24/outline';
import axios, { isAxiosError } from 'axios';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.AppLink', {
  title: 'Link an App',
  intro:
    'Enter the code a browser app, such as Pluet, shows you to let it use Seerr AI as you.',
  code: 'Code',
  next: 'Next',
  asks: '{app} on {site} wants to use Seerr AI as you.',
  explain:
    'It can do anything you can until you revoke it under API Keys in your profile. Only allow it if you just started this on {site} yourself.',
  allow: 'Allow',
  dontAllow: 'Don’t Allow',
  approved: 'Linked. Go back to {app}: it carries on by itself.',
  declined: 'Not linked. {app} was told no.',
  keys: 'See your API keys',
  switchedOff: 'Browser apps are turned off on this server.',
  failed: 'That didn’t work. Try again.',
});

interface Asking {
  code: string;
  app: string;
  site: string;
}

type Done = { approved: boolean; app: string };

const errorText = (e: unknown, fallback: string): string =>
  (isAxiosError(e) &&
    (e.response?.data as { message?: string } | undefined)?.message) ||
  fallback;

const AppLink = () => {
  const intl = useIntl();
  const router = useRouter();
  const { user } = useUser();
  const { currentSettings } = useSettings();
  const codeId = useId();
  const [code, setCode] = useState('');
  const [asking, setAsking] = useState<Asking>();
  const [done, setDone] = useState<Done>();
  const [problem, setProblem] = useState<string>();
  const [isBusy, setBusy] = useState(false);

  const check = useCallback(
    async (typed: string) => {
      setProblem(undefined);
      setBusy(true);
      try {
        const res = await axios.post<{ app: string; site: string }>(
          '/api/v1/auth/app-link/check',
          { code: typed }
        );
        setAsking({ code: typed, app: res.data.app, site: res.data.site });
      } catch (e) {
        setProblem(errorText(e, intl.formatMessage(messages.failed)));
      } finally {
        setBusy(false);
      }
    },
    [intl]
  );

  // From the link an app shows: the code is filled in and checked.
  const fromLink =
    typeof router.query.code === 'string' ? router.query.code : undefined;
  useEffect(() => {
    if (fromLink && currentSettings.browserApps) {
      setCode(fromLink);
      check(fromLink);
    }
  }, [fromLink, currentSettings.browserApps, check]);

  const answer = async (approve: boolean) => {
    if (!asking) {
      return;
    }
    setProblem(undefined);
    setBusy(true);
    try {
      await axios.post(
        `/api/v1/auth/app-link/${approve ? 'approve' : 'decline'}`,
        { code: asking.code }
      );
      setDone({ approved: approve, app: asking.app });
      setAsking(undefined);
    } catch (e) {
      setProblem(errorText(e, intl.formatMessage(messages.failed)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto mt-8 max-w-lg">
      <PageTitle title={intl.formatMessage(messages.title)} />
      <h1 className="heading flex items-center gap-2">
        <LinkIcon className="h-6 w-6" />
        {intl.formatMessage(messages.title)}
      </h1>
      {!currentSettings.browserApps ? (
        <div className="mt-6">
          <Alert
            type="warning"
            title={intl.formatMessage(messages.switchedOff)}
          />
        </div>
      ) : done ? (
        <div className="mt-6 space-y-4">
          <Alert
            type="info"
            title={intl.formatMessage(
              done.approved ? messages.approved : messages.declined,
              { app: done.app }
            )}
          />
          {done.approved && user && (
            <Link
              href="/profile/settings/api-keys"
              className="text-indigo-400 hover:underline"
            >
              {intl.formatMessage(messages.keys)}
            </Link>
          )}
        </div>
      ) : asking ? (
        <div className="mt-6 space-y-4">
          <p className="text-lg font-semibold text-white">
            {intl.formatMessage(messages.asks, {
              app: asking.app,
              site: asking.site,
            })}
          </p>
          <p className="text-gray-300">
            {intl.formatMessage(messages.explain, { site: asking.site })}
          </p>
          {problem && <Alert type="error" title={problem} />}
          <div className="flex gap-2">
            <Button
              buttonType="primary"
              disabled={isBusy}
              onClick={() => answer(true)}
            >
              {intl.formatMessage(messages.allow)}
            </Button>
            <Button disabled={isBusy} onClick={() => answer(false)}>
              {intl.formatMessage(messages.dontAllow)}
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="mt-6 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim()) {
              check(code.trim());
            }
          }}
        >
          <p className="text-gray-300">{intl.formatMessage(messages.intro)}</p>
          <div>
            <label htmlFor={codeId} className="text-label">
              {intl.formatMessage(messages.code)}
            </label>
            <input
              id={codeId}
              type="text"
              className="mt-1 w-full font-mono text-lg uppercase tracking-widest"
              value={code}
              maxLength={12}
              placeholder="K7M-Q2X"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
          {problem && <Alert type="error" title={problem} />}
          <Button
            buttonType="primary"
            type="submit"
            disabled={isBusy || !code.trim()}
          >
            {intl.formatMessage(messages.next)}
          </Button>
        </form>
      )}
    </div>
  );
};

export default AppLink;
