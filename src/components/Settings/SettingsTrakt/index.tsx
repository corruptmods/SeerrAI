import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownOnSquareIcon, TrashIcon } from '@heroicons/react/24/outline';
import axios, { isAxiosError } from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate as globalMutate } from 'swr';

const messages = defineMessages('components.Settings.SettingsTrakt', {
  title: 'Trakt',
  description:
    'Lets people import public Trakt lists into their lists, and have what is on their public Trakt watchlist requested for them. Nobody signs in to Trakt: Seerr AI only reads what is public.',
  clientId: 'Client ID',
  clientIdTip:
    'Make a Trakt app at <TraktAppsLink>developer.trakt.tv/apps</TraktAppsLink> (Trakt asks for a verified GitHub account), then paste its Client ID here. Trakt deletes apps that go unused for 30 days.',
  savedTip: 'A Client ID is saved. Enter a new one to replace it.',
  connected: 'Connected to Trakt.',
  removed: 'Trakt removed.',
  remove: 'Remove',
  saveFailed: 'Could not save: {reason}',
  badKey:
    'Trakt did not accept that Client ID. Check it, and that Trakt has approved the app.',
  unreachable: 'Could not reach Trakt. Try again in a while.',
  format: 'That does not look like a Trakt Client ID.',
});

/*
 * The Client ID of the admin's own Trakt app, one field: tested with Trakt
 * when saved, and never shown again once it is.
 */
const SettingsTrakt = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, mutate } = useSWR<{ hasClientId: boolean }>(
    '/api/v1/settings/trakt'
  );
  const [clientId, setClientId] = useState('');
  const [busy, setBusy] = useState(false);

  const reason = (e: unknown) => {
    const problem = isAxiosError(e) ? e.response?.data?.problem : undefined;
    return problem === 'badKey'
      ? intl.formatMessage(messages.badKey)
      : problem === 'format'
        ? intl.formatMessage(messages.format)
        : intl.formatMessage(messages.unreachable);
  };

  const refresh = async () => {
    await mutate();
    // The Import box and profile settings read whether Trakt is ready.
    await globalMutate('/api/v1/settings/public');
  };

  const save = async () => {
    setBusy(true);
    try {
      await axios.post('/api/v1/settings/trakt', { clientId: clientId.trim() });
      setClientId('');
      await refresh();
      addToast(intl.formatMessage(messages.connected), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch (e) {
      addToast(intl.formatMessage(messages.saveFailed, { reason: reason(e) }), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await axios.delete('/api/v1/settings/trakt');
      await refresh();
      addToast(intl.formatMessage(messages.removed), {
        appearance: 'info',
        autoDismiss: true,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="mb-6 mt-10">
        <h3 className="heading">{intl.formatMessage(messages.title)}</h3>
        <p className="description">
          {intl.formatMessage(messages.description)}
        </p>
      </div>
      <div className="section">
        {!data ? (
          <LoadingSpinner />
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (clientId.trim()) void save();
            }}
          >
            <div className="form-row">
              <label htmlFor="traktClientId" className="text-label">
                {intl.formatMessage(messages.clientId)}
                <span className="label-tip">
                  {intl.formatMessage(messages.clientIdTip, {
                    TraktAppsLink: (msg: React.ReactNode) => (
                      <a
                        href="https://developer.trakt.tv/apps"
                        className="text-white transition duration-300 hover:underline"
                        target="_blank"
                        rel="noreferrer"
                      >
                        {msg}
                      </a>
                    ),
                  })}
                </span>
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <SensitiveInput
                    id="traktClientId"
                    name="traktClientId"
                    autoComplete="off"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                  />
                </div>
                {data.hasClientId && (
                  <p className="mt-2 text-sm text-gray-400">
                    {intl.formatMessage(messages.savedTip)}
                  </p>
                )}
              </div>
            </div>
            <div className="actions">
              <div className="flex justify-end gap-3">
                {data.hasClientId && (
                  <Button
                    buttonType="danger"
                    type="button"
                    disabled={busy}
                    onClick={() => void remove()}
                  >
                    <TrashIcon />
                    <span>{intl.formatMessage(messages.remove)}</span>
                  </Button>
                )}
                <Button
                  buttonType="primary"
                  type="submit"
                  disabled={busy || !clientId.trim()}
                >
                  <ArrowDownOnSquareIcon />
                  <span>
                    {busy
                      ? intl.formatMessage(globalMessages.saving)
                      : intl.formatMessage(globalMessages.save)}
                  </span>
                </Button>
              </div>
            </div>
          </form>
        )}
      </div>
    </>
  );
};

export default SettingsTrakt;
