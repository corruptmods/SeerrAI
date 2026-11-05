import DeletionReview from '@app/components/Ai/DeletionReview';
import Slider from '@app/components/Slider';
import TmdbTitleCard from '@app/components/TitleCard/TmdbTitleCard';
import useDeletingSoon from '@app/hooks/useDeletingSoon';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.DeletingSoonSlider', {
  deletingSoon: 'Deleting Soon',
});

/**
 * Titles Maintainerr is about to delete, soonest first, with Keep in place of
 * Request. Only servers with the row on; hidden when nothing is due.
 */
const DeletingSoonSlider = () => {
  const intl = useIntl();
  const { rowItems: items } = useDeletingSoon();

  if (items.length === 0) {
    return null;
  }

  return (
    <>
      <div className="slider-header">
        <div className="slider-title">
          <span>{intl.formatMessage(messages.deletingSoon)}</span>
          <DeletionReview />
        </div>
      </div>
      <Slider
        sliderKey="deleting-soon"
        isLoading={false}
        items={items.map((item) => (
          <TmdbTitleCard
            key={`deleting-soon-${item.mediaType}-${item.tmdbId}`}
            // 0 when Seerr has no record, so the error card clears nothing
            // rather than the wrong title.
            id={item.mediaId ?? 0}
            tmdbId={item.tmdbId}
            type={item.mediaType as 'movie' | 'tv'}
          />
        ))}
      />
    </>
  );
};

export default DeletingSoonSlider;
