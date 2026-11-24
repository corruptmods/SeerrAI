import Modal from '@app/components/Common/Modal';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import axios, { isAxiosError } from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';

// Message ids predate this modal, so existing translations still apply.
const messages = defineMessages('components.Settings.SettingsTrakt', {
  addTrakt: 'Add Trakt',
  editTrakt: 'Edit Trakt',
  clientId: 'Client ID',
  clientIdTip:
    'Make an app at <TraktAppsLink>developer.trakt.tv/apps</TraktAppsLink> and paste its Client ID. Unused apps are deleted after 30 days.',
  savedTip: 'A Client ID is saved. Enter a new one to replace it.',
  connected: 'Connected to Trakt.',
  saveFailed: 'Could not save: {reason}',
  badKey:
    'Trakt did not accept that Client ID. Check it, and that Trakt has approved the app.',
  unreachable: 'Could not reach Trakt. Try again in a while.',
  format: 'That does not look like a Trakt Client ID.',
  watchHistory: 'Use What People Watched on Trakt',
  watchHistoryTip:
    'What each person watched on their public Trakt profile is left out of their suggestions and helps AI Search know their taste. They add their Trakt username in their profile.',
  savedSettings: 'Trakt settings saved.',
});

interface TraktModalProps {
  /** Whether a Client ID is saved already: editing it, else adding Trakt. */
  saved: boolean;
  /** Whether what people watched on Trakt is used now. */
  watchHistory: boolean;
  onClose: () => void;
  onSave: () => void;
}

/**
 * Adds or replaces the Client ID of the admin's own Trakt app: Trakt must
 * accept it before it is saved, and it is never shown again after. Once one
 * is saved, the watch history switch can change on its own.
 */
const TraktModal = ({
  saved,
  watchHistory: historyOn,
  onClose,
  onSave,
}: TraktModalProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [clientId, setClientId] = useState('');
  const [watchHistory, setWatchHistory] = useState(historyOn);
  const [busy, setBusy] = useState(false);
  const canSave = !!clientId.trim() || saved;

  const reason = (e: unknown) => {
    const problem = isAxiosError(e) ? e.response?.data?.problem : undefined;
    return problem === 'badKey'
      ? intl.formatMessage(messages.badKey)
      : problem === 'format'
        ? intl.formatMessage(messages.format)
        : intl.formatMessage(messages.unreachable);
  };

  const save = async () => {
    setBusy(true);
    try {
      await axios.post('/api/v1/settings/trakt', {
        ...(clientId.trim() && { clientId: clientId.trim() }),
        watchHistory,
      });
      addToast(
        intl.formatMessage(
          clientId.trim() ? messages.connected : messages.savedSettings
        ),
        {
          appearance: 'success',
          autoDismiss: true,
        }
      );
      onSave();
    } catch (e) {
      addToast(intl.formatMessage(messages.saveFailed, { reason: reason(e) }), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Transition
      as="div"
      appear
      show
      enter="transition-opacity ease-in-out duration-300"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition-opacity ease-in-out duration-300"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
    >
      <Modal
        onCancel={onClose}
        okButtonType="primary"
        okText={
          busy
            ? intl.formatMessage(globalMessages.saving)
            : saved
              ? intl.formatMessage(globalMessages.save)
              : intl.formatMessage(messages.addTrakt)
        }
        okDisabled={busy || !canSave}
        onOk={() => void save()}
        title={intl.formatMessage(
          saved ? messages.editTrakt : messages.addTrakt
        )}
      >
        <form
          className="mb-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave && !busy) void save();
          }}
        >
          <div className="form-row">
            <label htmlFor="traktClientId" className="text-label">
              {intl.formatMessage(messages.clientId)}
              <span className="label-required">*</span>
              <span className="label-tip">
                {intl.formatMessage(messages.clientIdTip, {
                  TraktAppsLink: (msg: React.ReactNode) => (
                    <a
                      href="https://developer.trakt.tv/apps"
                      className="text-strong transition duration-300 hover:underline"
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
              {saved && (
                <p className="mt-2 text-sm text-gray-400">
                  {intl.formatMessage(messages.savedTip)}
                </p>
              )}
            </div>
          </div>
          <div className="form-row">
            <label htmlFor="traktWatchHistory" className="checkbox-label">
              {intl.formatMessage(messages.watchHistory)}
              <span className="label-tip">
                {intl.formatMessage(messages.watchHistoryTip)}
              </span>
            </label>
            <div className="form-input-area">
              <input
                type="checkbox"
                id="traktWatchHistory"
                name="traktWatchHistory"
                checked={watchHistory}
                onChange={(e) => setWatchHistory(e.target.checked)}
              />
            </div>
          </div>
        </form>
      </Modal>
    </Transition>
  );
};

export default TraktModal;
