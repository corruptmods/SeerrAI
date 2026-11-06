import Badge from '@app/components/Common/Badge';
import defineMessages from '@app/utils/defineMessages';
import type { AvailableQuality, DynamicRange } from '@server/lib/mediaQuality';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.QualityBadges', {
  availableIn: 'Available in {qualities}',
});

/** Format names as people know them; the rest read as they are. */
const RANGE_NAMES: Partial<Record<DynamicRange, string>> = {
  DV: 'Dolby Vision',
};

/** The qualities a title is here in, as small badges beside its status. */
const QualityBadges = ({ quality }: { quality?: AvailableQuality }) => {
  const intl = useIntl();

  if (!quality?.resolutions.length) {
    return null;
  }

  const labels = [
    ...quality.resolutions,
    ...quality.ranges.map((range) => RANGE_NAMES[range] ?? range),
  ];

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className="sr-only">
        {intl.formatMessage(messages.availableIn, {
          qualities: labels.join(', '),
        })}
      </span>
      {labels.map((label) => (
        <span aria-hidden key={label}>
          <Badge badgeType="dark">{label}</Badge>
        </span>
      ))}
    </span>
  );
};

export default QualityBadges;
