import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import useDeletingSoon, { daysUntil } from '@app/hooks/useDeletingSoon';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import { ClockIcon, ShieldCheckIcon } from '@heroicons/react/24/solid';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.DeletingSoon', {
  deletingToday: 'Deleting today',
  deletingTomorrow: 'Deleting tomorrow',
  deletingInDays: 'Deleting in {days} days',
  keep: 'Keep',
  keeping: 'Keeping…',
  kept: '<strong>{title}</strong> will be kept.',
  keepFailed: 'Could not keep {title}: {message}',
});

export const useDeletingLabel = () => {
  const intl = useIntl();

  return (deleteAt: Date) => {
    const days = daysUntil(deleteAt);
    return days === 0
      ? intl.formatMessage(messages.deletingToday)
      : days === 1
        ? intl.formatMessage(messages.deletingTomorrow)
        : intl.formatMessage(messages.deletingInDays, { days });
  };
};

/**
 * The poster marker: same size and shape as the list and notify markers
 * beside it, in red.
 */
export const DeletingSoonMarker = ({
  tmdbId,
  mediaType,
}: {
  tmdbId: number;
  mediaType: string;
}) => {
  const { find } = useDeletingSoon();
  const label = useDeletingLabel();
  const item = find(tmdbId, mediaType);

  if (!item?.showBadge) {
    return null;
  }

  const when = new Date(item.deleteAt);

  return (
    <span
      className="flex h-4 w-4 items-center justify-center rounded-full border border-red-500 bg-red-600/90 shadow-md light:bg-red-600 sm:h-5 sm:w-5"
      title={label(when)}
    >
      <ClockIcon className="h-2.5 w-2.5 text-white sm:h-3 sm:w-3" />
    </span>
  );
};

/** The title-page badge, beside the status badges. */
export const DeletingSoonBadge = ({
  tmdbId,
  mediaType,
}: {
  tmdbId: number;
  mediaType: string;
}) => {
  const { find } = useDeletingSoon();
  const label = useDeletingLabel();
  const item = find(tmdbId, mediaType);

  if (!item?.showBadge) {
    return null;
  }

  const when = new Date(item.deleteAt);

  return (
    <Badge badgeType="danger">
      <span className="flex items-center">
        <ClockIcon className="mr-1 h-3.5 w-3.5" />
        {label(when)}
      </span>
    </Badge>
  );
};

/**
 * Keep: postpones the deletion. Shown wherever the Request button would be,
 * to anyone signed in, when the admin allows it.
 */
export const KeepButton = ({
  tmdbId,
  mediaType,
  title,
  compact = false,
  className,
}: {
  tmdbId: number;
  mediaType: string;
  title: string;
  /** The poster's small button rather than a title page's. */
  compact?: boolean;
  className?: string;
}) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { find, keep } = useDeletingSoon();
  const [isKeeping, setIsKeeping] = useState(false);

  if (!find(tmdbId, mediaType)?.canKeep) {
    return null;
  }

  return (
    <Button
      buttonType="success"
      buttonSize={compact ? 'sm' : 'md'}
      className={compact ? 'h-7 w-full' : className}
      disabled={isKeeping}
      onClick={async (e) => {
        e.preventDefault();
        setIsKeeping(true);
        try {
          await keep(tmdbId, mediaType);
          addToast(
            intl.formatMessage(messages.kept, {
              title,
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            }),
            { appearance: 'success', autoDismiss: true }
          );
        } catch (err) {
          addToast(
            intl.formatMessage(messages.keepFailed, {
              title,
              message: err?.response?.data?.message ?? err.message,
            }),
            { appearance: 'error', autoDismiss: true }
          );
        } finally {
          setIsKeeping(false);
        }
      }}
    >
      <ShieldCheckIcon />
      <span>
        {isKeeping
          ? intl.formatMessage(messages.keeping)
          : intl.formatMessage(messages.keep)}
      </span>
    </Button>
  );
};
