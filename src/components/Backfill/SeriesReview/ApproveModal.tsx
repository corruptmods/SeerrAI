import { appName, formatBytes } from '@app/components/Backfill/shared';
import type { CandidateView, TitleKind } from '@app/components/Backfill/types';
import Alert from '@app/components/Common/Alert';
import Modal from '@app/components/Common/Modal';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import axios from 'axios';
import { useEffect, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Backfill.ApproveModal', {
  title: 'Approve — {series}',
  titleAnyway: 'Approve anyway — {series}',
  approve: 'Approve & start download',
  approveAnyway: 'Approve anyway & start download',
  overrideWarning:
    '{app}’s quality profile turned down {count, plural, one {one of these files} other {# of these files}}: its quality isn’t in the profile, or it scores under the profile’s minimum. {count, plural, one {It is} other {They are}} imported anyway.',
  approving: 'Starting…',
  whatToImport: 'What to import',
  all: 'Missing and upgrades',
  allDetail:
    '{files} files · {size} · fills {fill} missing and upgrades {upgrade}',
  recommended: 'Recommended',
  missing: 'Missing episodes only',
  missingMovie: 'The missing movie',
  missingTracks: 'Missing tracks only',
  missingDetail: '{files} files · {size} · nothing on disk is touched',
  onlyFiles:
    'Only these files are downloaded. After {app} imports them, the torrent is removed without seeding.',
  usenetWhole:
    'The whole NZB is downloaded, but only these files are imported.',
  deleteWarning:
    '{count} {count, plural, one {file is} other {files are}} deleted for good as replacements import ({app}’s recycle bin is off).',
  typeToConfirm: 'Type {series} to confirm',
  includeAi:
    'Include the {count} {count, plural, one {file} other {files}} the AI placed',
  includeAiTip:
    'Their names didn’t say which episode; the AI placed them. Check under Show files first.',
  failed: 'The pack could not be approved.',
  unavailable:
    'This pack is no longer waiting for approval. Close this and choose again.',
});

const ApproveModal = ({
  show,
  kind,
  seriesTitle,
  candidate,
  unavailable = false,
  override = false,
  onClose,
  onApproved,
}: {
  show: boolean;
  kind: TitleKind;
  seriesTitle: string;
  candidate: CandidateView;
  /** The pack can no longer be approved; disables OK. */
  unavailable?: boolean;
  /**
   * Approve anyway: also the files only the quality profile turned down.
   */
  override?: boolean;
  onClose: () => void;
  onApproved: (jobId: number) => void;
}) => {
  const intl = useIntl();
  const plan = useMemo(() => candidate.plan ?? [], [candidate.plan]);
  const summary = candidate.summary;
  /** Turned down by the profile alone, and taken here as `action`. */
  const overriding = (
    e: (typeof plan)[number],
    action: 'fill' | 'upgrade'
  ): boolean =>
    override && e.action === 'reject' && e.override?.action === action;
  const fills =
    (summary?.fill ?? 0) + plan.filter((e) => overriding(e, 'fill')).length;
  const upgrades =
    (summary?.upgrade ?? 0) +
    plan.filter((e) => overriding(e, 'upgrade')).length;
  const hasUpgrades = upgrades > 0;
  const [mode, setMode] = useState<'missing' | 'all'>(
    hasUpgrades ? 'all' : 'missing'
  );
  const [confirm, setConfirm] = useState('');
  const [includeAi, setIncludeAi] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    if (show) {
      setMode(hasUpgrades ? 'all' : 'missing');
      setConfirm('');
      setIncludeAi(true);
      setProblem(undefined);
    }
  }, [show, hasUpgrades, candidate.id]);

  const pick = useMemo(() => {
    const taken = (e: (typeof plan)[number], m: 'missing' | 'all') =>
      e.action === 'fill' ||
      (m === 'all' && e.action === 'upgrade') ||
      (override &&
        e.action === 'reject' &&
        !!e.override &&
        (e.override.action === 'fill' || m === 'all'));
    const of = (m: 'missing' | 'all') =>
      plan.filter((e) => taken(e, m) && (includeAi || e.matchedBy !== 'ai'));
    return { missing: of('missing'), all: of('all') };
  }, [plan, includeAi, override]);
  const chosen = pick[mode];
  const aiInMode = plan.filter(
    (e) =>
      e.matchedBy === 'ai' &&
      (e.action === 'fill' || (mode === 'all' && e.action === 'upgrade'))
  ).length;
  const replaces = chosen.reduce(
    (n, e) =>
      n + (e.action === 'reject' ? (e.override?.replaces ?? 0) : e.replaces),
    0
  );
  const turnedDown = chosen.filter((e) => e.action === 'reject').length;
  const confirmed =
    replaces === 0 ||
    confirm.trim().toLowerCase() === seriesTitle.trim().toLowerCase();

  const approve = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      const { data } = await axios.post<{ id: number }>(
        `/api/v1/backfill/candidates/${candidate.id}/approve`,
        { mode, confirm, includeAi, ...(override ? { override: true } : {}) }
      );
      onApproved(data.id);
    } catch (e) {
      setProblem(
        axios.isAxiosError(e) && e.response?.data?.message
          ? String(e.response.data.message)
          : intl.formatMessage(messages.failed)
      );
    } finally {
      setBusy(false);
    }
  };

  const bytes = (entries: typeof plan) =>
    formatBytes(entries.reduce((n, e) => n + e.size, 0));

  const option = (
    value: 'missing' | 'all',
    label: string,
    detail: string,
    recommended = false
  ) => (
    <label
      className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${
        mode === value
          ? 'border-indigo-500 bg-indigo-600/10'
          : 'border-gray-700 bg-gray-900/40'
      }`}
    >
      <input
        type="radio"
        name="backfill-mode"
        className="mt-1"
        checked={mode === value}
        onChange={() => setMode(value)}
      />
      <span>
        <span className="font-semibold text-strong">{label}</span>
        {recommended && (
          <span className="ml-2 rounded-full bg-green-500/20 px-2 py-0.5 text-xs text-green-300 light:text-success-text">
            {intl.formatMessage(messages.recommended)}
          </span>
        )}
        <span className="block text-sm text-gray-400">{detail}</span>
      </span>
    </label>
  );

  return (
    <Transition
      as="div"
      show={show}
      enter="transition-opacity ease-in-out duration-300"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition-opacity ease-in-out duration-300"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
    >
      <Modal
        title={intl.formatMessage(
          override ? messages.titleAnyway : messages.title,
          { series: seriesTitle }
        )}
        subTitle={candidate.title}
        onCancel={onClose}
        onOk={approve}
        okText={intl.formatMessage(
          busy
            ? messages.approving
            : override
              ? messages.approveAnyway
              : messages.approve
        )}
        okButtonType="success"
        okDisabled={busy || unavailable || !confirmed || !chosen.length}
        loading={busy}
      >
        <div className="space-y-4">
          {unavailable && (
            <Alert
              type="warning"
              title={intl.formatMessage(messages.unavailable)}
            />
          )}
          {problem && <Alert type="error" title={problem} />}
          {turnedDown > 0 && (
            <Alert
              type="warning"
              title={intl.formatMessage(messages.overrideWarning, {
                app: appName(kind),
                count: turnedDown,
              })}
            />
          )}
          <div className="text-label">
            {intl.formatMessage(messages.whatToImport)}
          </div>
          <div className="space-y-2">
            {hasUpgrades &&
              option(
                'all',
                intl.formatMessage(messages.all),
                intl.formatMessage(messages.allDetail, {
                  files: pick.all.length,
                  size: bytes(pick.all),
                  fill: fills,
                  upgrade: upgrades,
                }),
                true
              )}
            {fills > 0 &&
              option(
                'missing',
                intl.formatMessage(
                  kind === 'movie'
                    ? messages.missingMovie
                    : kind === 'album'
                      ? messages.missingTracks
                      : messages.missing
                ),
                intl.formatMessage(messages.missingDetail, {
                  files: pick.missing.length,
                  size: bytes(pick.missing),
                })
              )}
          </div>
          {aiInMode > 0 && (
            <label
              htmlFor="backfill-include-ai"
              aria-label={intl.formatMessage(messages.includeAi, {
                count: aiInMode,
              })}
              className="flex cursor-pointer gap-3 rounded-lg border border-purple-500/40 bg-purple-500/10 p-3"
            >
              <input
                id="backfill-include-ai"
                type="checkbox"
                className="mt-1"
                checked={includeAi}
                onChange={(e) => setIncludeAi(e.target.checked)}
              />
              <span>
                <span className="font-semibold text-strong">
                  {intl.formatMessage(messages.includeAi, { count: aiInMode })}
                </span>
                <span className="block text-sm text-gray-400">
                  {intl.formatMessage(messages.includeAiTip)}
                </span>
              </span>
            </label>
          )}
          <p className="text-sm text-gray-400">
            {intl.formatMessage(
              candidate.protocol === 'torrent'
                ? messages.onlyFiles
                : messages.usenetWhole,
              { app: appName(kind) }
            )}
          </p>
          {replaces > 0 && (
            <Alert
              type="error"
              title={intl.formatMessage(messages.deleteWarning, {
                count: replaces,
                app: appName(kind),
              })}
            >
              <label
                htmlFor="backfill-confirm"
                className="mb-1 mt-2 block text-sm text-red-100 light:text-danger-text"
              >
                {intl.formatMessage(messages.typeToConfirm, {
                  series: seriesTitle,
                })}
              </label>
              <input
                id="backfill-confirm"
                type="text"
                autoComplete="off"
                className="w-full max-w-xs"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </Alert>
          )}
        </div>
      </Modal>
    </Transition>
  );
};

export default ApproveModal;
