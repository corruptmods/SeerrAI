import Modal from '@app/components/Common/Modal';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.MediaLists.PlaylistLinkModal', {
  title: 'Import a playlist',
  instructions:
    'Paste a Spotify or Apple Music playlist’s share link. Its songs come in now, and songs added to it later come in each day; each is requested for you, within your song limit.',
  privateNote:
    'A private playlist has to be shared or made public first. Spotify links bring in up to 100 songs.',
  placeholder: 'https://open.spotify.com/playlist/…',
  link: 'Import',
  linking: 'Reading the playlist…',
  failed: 'That didn’t work: {detail}',
});

/** Links a playlist to a Spotify or Apple Music playlist by its share link. */
const PlaylistLinkModal = ({
  listId,
  onClose,
  onLinked,
}: {
  listId: number;
  onClose: () => void;
  onLinked: () => void;
}) => {
  const intl = useIntl();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const link = async () => {
    setBusy(true);
    setError(null);
    try {
      await axios.post(`/api/v1/list/${listId}/link`, { url: url.trim() });
      onLinked();
      onClose();
    } catch (e) {
      setError(
        intl.formatMessage(messages.failed, {
          detail:
            (axios.isAxiosError(e) && e.response?.data?.message) ||
            (e instanceof Error ? e.message : String(e)),
        })
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Transition
      appear
      as="div"
      enter="transition-opacity duration-300"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition-opacity duration-300"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
      show
    >
      <Modal
        backgroundClickable={false}
        loading={busy}
        okButtonType="primary"
        okDisabled={!url.trim() || busy}
        okText={intl.formatMessage(busy ? messages.linking : messages.link)}
        onCancel={onClose}
        onOk={link}
        title={intl.formatMessage(messages.title)}
      >
        {error && (
          <p className="mb-3 rounded bg-red-900/40 px-3 py-2 text-sm text-red-200">
            {error}
          </p>
        )}
        <p className="mb-2 text-sm text-gray-300">
          {intl.formatMessage(messages.instructions)}
        </p>
        <p className="mb-3 text-xs text-gray-400">
          {intl.formatMessage(messages.privateNote)}
        </p>
        <input
          className="w-full rounded border-gray-600 bg-gray-700 px-3 py-2 text-sm text-white"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && url.trim() && !busy) void link();
          }}
          placeholder={intl.formatMessage(messages.placeholder)}
          type="url"
          value={url}
        />
      </Modal>
    </Transition>
  );
};

export default PlaylistLinkModal;
