import Modal from '@app/components/Common/Modal';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.TrailerModal', {
  trailer: 'Trailer',
  openOnYoutube: 'Open on YouTube',
});

interface TrailerModalProps {
  /** The YouTube video id. */
  videoKey?: string;
  name?: string;
  /** Where the trailer is on YouTube. */
  url?: string;
  show: boolean;
  onClose: () => void;
}

/**
 * A YouTube trailer played in the page. youtube-nocookie stores nothing until
 * it plays; closing removes the player, which stops it.
 */
const TrailerModal = ({
  videoKey,
  name,
  url,
  show,
  onClose,
}: TrailerModalProps) => {
  const intl = useIntl();
  const title = name || intl.formatMessage(messages.trailer);

  return (
    <Transition
      as="div"
      enter="transition-opacity duration-300"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition-opacity duration-300"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
      show={show && !!videoKey}
    >
      <Modal
        title={title}
        onCancel={onClose}
        showCloseButton
        dialogClass="sm:max-w-5xl"
        okText={url ? intl.formatMessage(messages.openOnYoutube) : undefined}
        onOk={
          url
            ? () => {
                window.open(url, '_blank', 'noopener,noreferrer');
                onClose();
              }
            : undefined
        }
      >
        <div className="aspect-video w-full overflow-hidden rounded-lg bg-black">
          <iframe
            className="h-full w-full"
            src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(
              videoKey ?? ''
            )}?autoplay=1&rel=0&playsinline=1`}
            title={title}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        </div>
      </Modal>
    </Transition>
  );
};

export default TrailerModal;
