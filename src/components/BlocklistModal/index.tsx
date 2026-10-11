import Modal from '@app/components/Common/Modal';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';

import type { Collection } from '@server/models/Collection';
import type { MovieDetails } from '@server/models/Movie';
import type { TvDetails } from '@server/models/Tv';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

interface BlocklistModalProps {
  tmdbId: number;
  type: 'movie' | 'tv' | 'collection';
  show: boolean;
  /** Called with the reason typed, if any, when the blocklist is confirmed. */
  onComplete?: (reason?: string) => void;
  onCancel?: () => void;
  isUpdating?: boolean;
  /**
   * The title is already requested or downloaded, so blocklisting it will
   * also remove it from Radarr/Sonarr and delete its files. Shown as a
   * warning, with the button saying so, because it cannot be undone.
   */
  removesFiles?: boolean;
}

const messages = defineMessages('component.BlocklistModal', {
  blocklisting: 'Blocklisting',
  blocklistanddelete: 'Blocklist and delete files',
  reason: 'Reason',
  reasonplaceholder: 'Reason (optional)',
  removesfiles:
    'This will also remove it from {arr} and permanently delete its files, and decline any open requests for it. This cannot be undone.',
});

const isCollection = (
  data: MovieDetails | TvDetails | Collection | null
): data is Collection => {
  return (
    data !== null &&
    data !== undefined &&
    (data as Collection).parts !== undefined
  );
};

const isMovie = (
  movie: MovieDetails | TvDetails | Collection | null
): movie is MovieDetails => {
  if (!movie) return false;
  return (movie as MovieDetails).title !== undefined;
};

const BlocklistModal = ({
  tmdbId,
  type,
  show,
  onComplete,
  onCancel,
  isUpdating,
  removesFiles,
}: BlocklistModalProps) => {
  const intl = useIntl();
  const [data, setData] = useState<
    TvDetails | MovieDetails | Collection | null
  >(null);
  const [error, setError] = useState(null);
  const [reason, setReason] = useState('');

  useEffect(() => {
    // Each opening starts blank, so a reason typed for one title never
    // carries over to the next.
    if (show) {
      setReason('');
    }
  }, [show]);

  useEffect(() => {
    (async () => {
      if (!show) return;
      try {
        setError(null);
        const response = await axios.get(`/api/v1/${type}/${tmdbId}`);
        setData(response.data);
      } catch (err) {
        setError(err);
      }
    })();
  }, [show, tmdbId, type]);

  return (
    <Transition
      as="div"
      enter="transition-opacity duration-300"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition-opacity duration-300"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
      show={show}
    >
      <Modal
        loading={!data && !error}
        backgroundClickable
        title={`${intl.formatMessage(globalMessages.blocklist)} ${
          type === 'collection'
            ? intl.formatMessage(globalMessages.collection)
            : isMovie(data)
              ? intl.formatMessage(globalMessages.movie)
              : intl.formatMessage(globalMessages.tvshow)
        }`}
        subTitle={`${
          isCollection(data)
            ? data.name
            : isMovie(data)
              ? data.title
              : data?.name
        }`}
        onCancel={onCancel}
        onOk={() => onComplete?.(reason.trim() || undefined)}
        okText={
          isUpdating
            ? intl.formatMessage(messages.blocklisting)
            : removesFiles
              ? intl.formatMessage(messages.blocklistanddelete)
              : intl.formatMessage(globalMessages.blocklist)
        }
        okButtonType="danger"
        okDisabled={isUpdating}
        backdrop={`https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/${data?.backdropPath}`}
      >
        {removesFiles && (
          <p className="mb-4 text-sm text-red-300">
            {intl.formatMessage(messages.removesfiles, {
              arr: type === 'movie' ? 'Radarr' : 'Sonarr',
            })}
          </p>
        )}
        <label htmlFor="blocklist-reason" className="sr-only">
          {intl.formatMessage(messages.reason)}
        </label>
        <textarea
          id="blocklist-reason"
          className="h-20"
          maxLength={500}
          placeholder={intl.formatMessage(messages.reasonplaceholder)}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Modal>
    </Transition>
  );
};

export default BlocklistModal;
