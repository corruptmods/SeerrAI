import Button from '@app/components/Common/Button';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import defineMessages from '@app/utils/defineMessages';
import {
  CheckIcon,
  HandRaisedIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type { AgentRunDetail } from '@server/interfaces/api/agentInterfaces';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Backfill.Agent.ProposalCard', {
  proposalTitle: 'Waiting for your approval',
  proposalIntro:
    'Nothing below has been done yet. Approve to do it now, or decline to change nothing.',
  approve: 'Approve',
  approveDelete: 'Approve and delete',
  confirmApprove: 'Delete for good?',
  decline: 'Decline',
  deciding: 'Working…',
});

/**
 * What the agent proposed, for an admin to approve or decline. Deleting
 * files takes a second click.
 */
const ProposalCard = ({
  proposal,
  onDecide,
  busy,
}: {
  proposal: NonNullable<AgentRunDetail['proposal']>;
  onDecide: (approve: boolean) => void;
  busy: boolean;
}) => {
  const intl = useIntl();
  const deletes = proposal.changes.some((c) => c.kind === 'deleteFiles');
  return (
    <section
      aria-labelledby="agent-proposal"
      className="mt-4 rounded-lg bg-yellow-500/10 px-5 py-4 ring-1 ring-yellow-500/60"
    >
      <h2
        id="agent-proposal"
        className="flex items-center gap-2 text-sm font-semibold text-yellow-100 light:text-warning-text"
      >
        <HandRaisedIcon className="h-5 w-5 flex-none text-yellow-300 light:text-warning-text" />
        {intl.formatMessage(messages.proposalTitle)}
      </h2>
      <p className="mt-1 text-xs text-yellow-100/80 light:text-warning-text">
        {intl.formatMessage(messages.proposalIntro)}
      </p>
      <ol className="mt-3 space-y-3">
        {proposal.changes.map((change, i) => (
          <li
            key={`${change.kind}-${i}`}
            className="rounded-md bg-gray-900/60 px-3 py-2 ring-1 ring-gray-700"
          >
            <div className="text-sm font-medium text-strong">
              {change.headline}
            </div>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-gray-300">
              {change.details.map((line, j) => (
                <li key={j} className="break-words">
                  {line}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
        <Button
          buttonType="default"
          disabled={busy}
          onClick={() => onDecide(false)}
        >
          <XMarkIcon />
          <span>{intl.formatMessage(messages.decline)}</span>
        </Button>
        {deletes ? (
          <ConfirmButton
            onClick={() => !busy && onDecide(true)}
            confirmText={intl.formatMessage(messages.confirmApprove)}
          >
            <CheckIcon />
            <span>{intl.formatMessage(messages.approveDelete)}</span>
          </ConfirmButton>
        ) : (
          <Button
            buttonType="primary"
            disabled={busy}
            onClick={() => onDecide(true)}
          >
            <CheckIcon />
            <span>
              {intl.formatMessage(busy ? messages.deciding : messages.approve)}
            </span>
          </Button>
        )}
      </div>
    </section>
  );
};

export default ProposalCard;
