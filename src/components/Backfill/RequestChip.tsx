import { AiSearchingBadge } from '@app/components/Backfill/shared';
import type { SeriesView } from '@app/components/Backfill/types';
import Badge from '@app/components/Common/Badge';
import defineMessages from '@app/utils/defineMessages';
import type { BackfillStatus } from '@server/interfaces/api/backfillStatus';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Backfill.RequestChip', {
  backfill: 'Backfill',
  downloading: 'Downloading {progress}%',
  waiting: 'Pack waiting for approval',
  stuck: 'Stuck',
  searching: 'Searching…',
  none: 'Nothing found yet',
  ignored: 'Ignored',
  lookingLabel: 'Also',
  looking: 'Looking further for this',
  foundElsewhere: 'Found elsewhere, downloading {progress}%',
});

export type BackfillLookup = SeriesView & {
  readyCount: number;
  workingRunId?: number | null;
  job?: { id: number; progress: number };
  jobs?: { id: number; progress: number }[];
};

/** On a stuck request, for admins: where Backfill is with it. */
const BackfillRequestChip = ({ backfill }: { backfill: BackfillLookup }) => {
  const intl = useIntl();
  const [type, text, href] = backfill.job
    ? ([
        'primary',
        intl.formatMessage(messages.downloading, {
          progress: backfill.job.progress,
        }),
        `/backfill/jobs/${backfill.job.id}`,
      ] as const)
    : backfill.readyCount
      ? ([
          'warning',
          intl.formatMessage(messages.waiting),
          `/backfill/series/${backfill.id}`,
        ] as const)
      : ([
          backfill.status === 'none' ? 'danger' : 'default',
          intl.formatMessage(
            backfill.status === 'searching'
              ? messages.searching
              : backfill.status === 'none'
                ? messages.none
                : backfill.status === 'ignored'
                  ? messages.ignored
                  : messages.stuck
          ),
          `/backfill/series/${backfill.id}`,
        ] as const);
  return (
    <div className="card-field">
      <span className="card-field-name">
        {intl.formatMessage(messages.backfill)}
      </span>
      <div className="flex min-w-0 flex-wrap gap-1">
        {/* The admin agent looking is what's happening, in place of what
            Backfill's own search last found. */}
        {backfill.workingRunId ? (
          <AiSearchingBadge runId={backfill.workingRunId} />
        ) : (
          <Badge badgeType={type} href={href}>
            {text}
          </Badge>
        )}
      </div>
    </div>
  );
};

/**
 * On someone's own request: that Backfill is looking beyond the usual
 * search for it, or downloading what it found. Nothing more.
 */
export const BackfillStatusLine = ({ status }: { status: BackfillStatus }) => {
  const intl = useIntl();
  return (
    <div className="card-field">
      <span className="card-field-name">
        {intl.formatMessage(messages.lookingLabel)}
      </span>
      <div className="flex min-w-0 flex-wrap gap-1">
        {status.agent ? (
          <AiSearchingBadge />
        ) : (
          <Badge
            badgeType={status.state === 'downloading' ? 'primary' : 'default'}
          >
            {status.state === 'downloading'
              ? intl.formatMessage(messages.foundElsewhere, {
                  progress: status.progress ?? 0,
                })
              : intl.formatMessage(messages.looking)}
          </Badge>
        )}
      </div>
    </div>
  );
};

export default BackfillRequestChip;
