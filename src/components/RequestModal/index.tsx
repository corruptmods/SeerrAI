import type { RequestPreselect } from '@app/components/RequestModal/TvRequestModal';
import useLazyModule, { preloadModule } from '@app/hooks/useLazyModule';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import type { MediaStatus } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { NonFunctionProperties } from '@server/interfaces/api/common';
import { useEffect } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.RequestModal', {
  couldNotOpen:
    'The request could not be opened. Check your connection and try again.',
});

/*
 * The request dialogs, with the select menus and quota logic they carry, are
 * a large share of every page with a poster on it — yet they only matter once
 * someone taps Request. They load separately, and are fetched while the
 * browser is otherwise idle, so the first tap still opens at once. If loading
 * fails, the dialog closes with a message and the next tap tries again.
 */
const loaders = {
  movie: () => import('@app/components/RequestModal/MovieRequestModal'),
  tv: () => import('@app/components/RequestModal/TvRequestModal'),
  collection: () =>
    import('@app/components/RequestModal/CollectionRequestModal'),
  music: () => import('@app/components/RequestModal/MusicRequestModal'),
};

interface CommonProps {
  show: boolean;
  is4k?: boolean;
  editRequest?: NonFunctionProperties<MediaRequest>;
  onComplete?: (newStatus: MediaStatus) => void;
  onCancel?: () => void;
  onUpdating?: (isUpdating: boolean) => void;
}

interface VideoRequestModalProps extends CommonProps {
  type: 'movie' | 'tv' | 'collection';
  tmdbId: number;
  /** Series only: open with this season, or one episode of it, ticked. */
  preselect?: RequestPreselect;
}

/** Music is asked for by its MusicBrainz ids, not a TMDB id. */
interface MusicModalProps extends CommonProps {
  type: 'music';
  artistMbid: string;
  /** Opens with only this album ticked. */
  albumMbid?: string;
}

type RequestModalProps = VideoRequestModalProps | MusicModalProps;

const RequestModal = (props: RequestModalProps) => {
  const { type, show, is4k, editRequest, onComplete, onUpdating, onCancel } =
    props;
  const intl = useIntl();
  const { addToast } = useToasts();

  // Each dialog's own wrapper below knows what its module holds.
  const loader: () => Promise<unknown> = loaders[type];

  useEffect(() => preloadModule(loader), [loader]);

  const dialog = useLazyModule(loader, show, () => {
    addToast(intl.formatMessage(messages.couldNotOpen), {
      appearance: 'error',
      autoDismiss: true,
    });
    onCancel?.();
  });

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
      {!!dialog &&
        (props.type === 'music' ? (
          <MusicDialog
            module={dialog}
            onComplete={onComplete}
            onCancel={onCancel}
            onUpdating={onUpdating}
            artistMbid={props.artistMbid}
            albumMbid={props.albumMbid}
            editRequest={editRequest}
          />
        ) : props.type === 'movie' ? (
          <MovieDialog
            module={dialog}
            onComplete={onComplete}
            onCancel={onCancel}
            tmdbId={props.tmdbId}
            onUpdating={onUpdating}
            is4k={is4k}
            editRequest={editRequest}
          />
        ) : props.type === 'tv' ? (
          <TvDialog
            module={dialog}
            onComplete={onComplete}
            onCancel={onCancel}
            tmdbId={props.tmdbId}
            onUpdating={onUpdating}
            is4k={is4k}
            editRequest={editRequest}
            preselect={props.preselect}
          />
        ) : (
          <CollectionDialog
            module={dialog}
            onComplete={onComplete}
            onCancel={onCancel}
            tmdbId={props.tmdbId}
            onUpdating={onUpdating}
            is4k={is4k}
          />
        ))}
    </Transition>
  );
};

type Loaded<K extends keyof typeof loaders> = Awaited<
  ReturnType<(typeof loaders)[K]>
>;
type PropsOf<K extends keyof typeof loaders> = React.ComponentProps<
  Loaded<K>['default']
>;

const MovieDialog = ({
  module,
  ...props
}: PropsOf<'movie'> & { module: unknown }) => {
  const Dialog = (module as Loaded<'movie'>).default;
  return <Dialog {...props} />;
};
const TvDialog = ({
  module,
  ...props
}: PropsOf<'tv'> & { module: unknown }) => {
  const Dialog = (module as Loaded<'tv'>).default;
  return <Dialog {...props} />;
};
const MusicDialog = ({
  module,
  ...props
}: PropsOf<'music'> & { module: unknown }) => {
  const Dialog = (module as Loaded<'music'>).default;
  return <Dialog {...props} />;
};
const CollectionDialog = ({
  module,
  ...props
}: PropsOf<'collection'> & { module: unknown }) => {
  const Dialog = (module as Loaded<'collection'>).default;
  return <Dialog {...props} />;
};

export default RequestModal;
