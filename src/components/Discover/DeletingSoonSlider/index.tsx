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
 * Everything Maintainerr is about to delete, soonest first. Each card carries
 * its red marker and a Keep button in place of Request. Includes titles from
 * servers with the row switched on; hidden when nothing is due.
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
            // Seerr's media id, which the admin error card acts on. 0 when
            // Seerr has no record: that clears nothing rather than the wrong
            // title.
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
