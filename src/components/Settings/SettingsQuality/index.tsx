import RadarrLogo from '@app/assets/services/radarr.svg';
import SonarrLogo from '@app/assets/services/sonarr.svg';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import PreviewModal from '@app/components/Settings/SettingsQuality/PreviewModal';
import WhatItDoes from '@app/components/Settings/SettingsQuality/WhatItDoes';
import {
  formatLabel,
  presetLabel,
} from '@app/components/Settings/SettingsQuality/labels';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowDownOnSquareIcon,
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  ChevronDownIcon,
  DocumentMagnifyingGlassIcon,
  EyeIcon,
} from '@heroicons/react/24/outline';
import type { ServerFormat } from '@server/lib/quality/describe';
import type { ServerState } from '@server/lib/quality/engine';
import type {
  ArrKind,
  BandStep,
  Nudge,
  PresetKey,
  PresetSource,
  QualityAdjustments,
} from '@server/lib/quality/types';
import { BAND_STEPS, PRESET_KEYS } from '@server/lib/quality/types';
import axios from 'axios';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { FormattedRelativeTime, useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Settings.SettingsQuality', {
  quality: 'Quality',
  description:
    'Seerr AI can set up quality profiles in Radarr and Sonarr for you, from its own presets or TRaSH Guides, with your adjustments on top. Nothing is sent to a server until you manage it and apply. It only changes the profiles it creates.',
  trash: 'TRaSH Guides',
  trashChecked: 'Last checked {when}. Applies to every managed server.',
  trashNever: 'Not fetched yet: it is fetched when a preset first uses it.',
  trashFailed: 'The last check failed: {error}',
  checkNow: 'Check now',
  checked: 'TRaSH Guides checked.',
  credit: 'TRaSH Guides is used under its MIT licence, copyright TRaSH.',
  autoApply: 'Apply updates automatically',
  autoApplyTip:
    'Off: updates wait for you to preview them. On: each one goes in History, with an Undo.',
  fillGaps: 'Fill gaps with Seerr AI',
  fillGapsTip:
    'Builds what TRaSH Guides doesn’t have, like SD and 720p, and adds your rules beside it.',
  servers: 'Servers',
  serversTip:
    'Each server has its own presets and adjustments. New servers start as Not managed.',
  noServers: 'Add a Radarr or Sonarr server in Services first.',
  notManaged: 'Not managed',
  ready: 'Ready to apply',
  inSync: 'In sync',
  updateReady: 'TRaSH update ready',
  changed: 'Changed in {app}',
  kept: 'Kept as edited',
  unreachable: 'Can’t be reached',
  unsupported: 'Needs Sonarr v4',
  notManagedText: 'Seerr AI hasn’t changed anything on this server.',
  manageTip:
    'Pick its presets and adjustments, then preview. Nothing is sent until you press Apply, and your own profiles stay as they are.',
  readyText: 'Your choices aren’t on the server yet.',
  updateText: 'TRaSH Guides has changed since it was last applied.',
  changedText: 'Someone changed {names} in {app}.',
  removedText:
    '{names} {count, plural, one {was} other {were}} removed in {app}.',
  keptText: 'Kept as someone edited it in {app}: {names}.',
  clashText:
    'TRaSH Guides changed {names}, which you moved; your choice stays.',
  appliedAt: 'Applied {when}',
  unsupportedText: 'Sonarr v4 or later is needed for custom formats.',
  manage: 'Manage this server',
  stopManaging: 'Stop managing',
  stopManagingTip:
    'Its profiles stay in {app}, still working; Seerr AI stops changing them.',
  previewApply: 'Preview & apply',
  putBack: 'Put it back',
  keepChange: 'Keep their change',
  keptChange: '{count, plural, one {Kept # change} other {Kept # changes}}.',
  presetsFor: 'Presets for {server}',
  presetsTip:
    'Pick where each comes from, or leave it off. Tap one to see what it does.',
  sourceSeerr: 'Seerr AI',
  sourceTrash: 'TRaSH Guides',
  sourceOff: 'Off',
  fromSeerr: 'Seerr AI’s preset',
  fromTrash: 'From TRaSH Guides',
  filledIn: 'Filled in by Seerr AI',
  noTrash: 'TRaSH Guides has none; Fill gaps is off',
  offText: 'Not created',
  whatItDoes: 'What it does',
  adjustmentsFor: 'Adjustments for {server}',
  adjustmentsTip:
    'On top of this server’s presets, whichever source they come from.',
  copyFrom: 'Copy from another server',
  copied: 'Copied from {server}.',
  preferUsenet: 'Prefer usenet',
  preferEqualTip: 'Releases of the same quality tie, so usenet wins them.',
  preferAlwaysTip:
    'Torrents wait, so usenet gets the first chance. Set in the delay profile, shown in the preview.',
  preferNoneTip: 'Scores exactly as the preset sets them.',
  preferEqual: 'At equal quality (recommended)',
  preferAlways: 'Whenever usenet has it',
  preferNone: 'No preference',
  torrentsWait: 'Torrents wait',
  hours: 'hours',
  fileSize: 'File size',
  fileSizeTip: 'How big a release may be.',
  fileSizeSonarr4:
    'Sonarr v4 keeps sizes for the whole server, so they stay as Sonarr has them.',
  sizeSmall: 'Smaller files',
  sizeBalanced: 'Balanced',
  sizeBest: 'Best quality',
  languages: 'Languages',
  languagesTip: 'Audio the release must have.',
  langEnglishOriginal: 'English, or the original language',
  langOriginal: 'The original language',
  langAny: 'Any',
  hdr: 'HDR and Dolby Vision',
  hdrTip: 'On 2160p presets only.',
  x265: 'Allow x265 at 1080p',
  x265Tip: 'Smaller files; some older TVs can’t play them.',
  dualAudio: 'Dual audio for anime',
  dualAudioTip: 'The English dub with the original audio comes first.',
  singleEpisodes: 'Single episodes first',
  singleEpisodesTip: 'Files with more than one episode only as a last resort.',
  burnedIn: 'Burned-in subtitles as a last resort',
  burnedInTip: 'Only when nothing else is out.',
  av1: 'AV1 as a last resort',
  av1Tip:
    'Many TVs and streaming boxes can’t play AV1, so Plex converts it as you watch. Off: taken like any other.',
  advanced: 'Advanced',
  advancedTip: 'The band step, and moving single formats between bands.',
  bandStep: 'Band step',
  bandStepTip:
    'Scores round to this, so near-equal releases tie and usenet wins. Bigger means more ties.',
  asSet: 'As set',
  up: 'Up a band',
  down: 'Down a band',
  never: 'Never',
  stepDown:
    'A title nothing matches for a long time can step down a preset for a while, then back up. Off unless you turn it on.',
  stepDownLink: 'Set it in Backfill',
  history: 'History',
  noHistory: 'Nothing applied yet.',
  historyLine:
    '{created, plural, one {# created} other {# created}}, {updated, plural, one {# updated} other {# updated}}',
  historyMoved: '{count, plural, one {# title moved} other {# titles moved}}',
  historyTrash: 'TRaSH Guides update, applied automatically',
  historyBy: 'by {name}',
  undo: 'Undo',
  undone: 'Undone',
  undoDone: 'Undone: {restored} put back, {removed} removed.',
  undoKept:
    '{names} stayed, because titles or request settings use {count, plural, one {it} other {them}}.',
  undoFailed: 'Could not undo: {detail}',
  saved: 'Quality settings saved.',
  saveFailed: 'Could not save: {detail}',
  unsaved: 'You have changes that aren’t saved.',
});

type ServerView = ServerState & {
  managed: boolean;
  presets: Partial<Record<PresetKey, PresetSource>>;
  adjustments: QualityAdjustments;
  nudges: Record<string, Nudge>;
  bandStep: BandStep;
};

interface HistoryEntry {
  id: number;
  kind: ArrKind;
  serverId: number;
  serverName: string;
  created: number;
  updated: number;
  trash: boolean;
  moved: number;
  by: string | null;
  createdAt: string;
  undoneAt: string | null;
  canUndo: boolean;
}

interface QualityView {
  trash: {
    autoApply: boolean;
    fillGaps: boolean;
    commit?: string;
    checkedAt?: string;
    failedAt?: string;
    error?: string;
  };
  servers: ServerView[];
  history: HistoryEntry[];
}

type Draft = Pick<
  ServerView,
  | 'kind'
  | 'serverId'
  | 'managed'
  | 'presets'
  | 'adjustments'
  | 'nudges'
  | 'bandStep'
>;

const keyOf = (s: { kind: ArrKind; serverId: number }) =>
  `${s.kind}:${s.serverId}`;

const draftOf = (s: ServerView): Draft => ({
  kind: s.kind,
  serverId: s.serverId,
  managed: s.managed,
  presets: { ...s.presets },
  adjustments: { ...s.adjustments },
  nudges: { ...s.nudges },
  bandStep: s.bandStep,
});

const errorOf = (e: unknown) =>
  (axios.isAxiosError(e) && e.response?.data?.message) ||
  (e instanceof Error ? e.message : String(e));

const relative = (iso: string) => (
  <FormattedRelativeTime
    value={Math.floor((new Date(iso).getTime() - Date.now()) / 1000)}
    updateIntervalInSeconds={60}
    numeric="auto"
  />
);

const Logo = ({ kind, className }: { kind: ArrKind; className: string }) =>
  kind === 'radarr' ? (
    <RadarrLogo className={className} />
  ) : (
    <SonarrLogo className={className} />
  );

const DOT: Record<ServerState['status'], string> = {
  'not-managed': 'bg-gray-500',
  ready: 'bg-indigo-400',
  'in-sync': 'bg-green-500',
  'update-ready': 'bg-indigo-400',
  changed: 'bg-yellow-500',
  kept: 'bg-gray-400',
  unreachable: 'bg-red-500',
  unsupported: 'bg-red-500',
};

const Row = ({
  id,
  label,
  tip,
  children,
}: {
  id: string;
  label: string;
  tip?: string;
  children: React.ReactNode;
}) => (
  <div className="form-row">
    <label htmlFor={id} className="checkbox-label">
      {label}
      {tip && <span className="label-tip">{tip}</span>}
    </label>
    <div className="form-input-area">{children}</div>
  </div>
);

const SettingsQuality = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, error, mutate } = useSWR<QualityView>(
    '/api/v1/settings/quality'
  );
  const [trash, setTrash] = useState<QualityView['trash'] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState<{ restoreKept: boolean } | null>(
    null
  );
  const [describing, setDescribing] = useState<PresetKey | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!data) return;
    setTrash(data.trash);
    setDrafts(
      Object.fromEntries(data.servers.map((s) => [keyOf(s), draftOf(s)]))
    );
    setSelected(
      (current) =>
        current ??
        keyOf(
          data.servers.find((s) => s.managed) ??
            data.servers[0] ?? { kind: 'radarr', serverId: -1 }
        )
    );
  }, [data]);

  const saved = useMemo(
    () =>
      data
        ? JSON.stringify({
            trash: {
              autoApply: data.trash.autoApply,
              fillGaps: data.trash.fillGaps,
            },
            servers: data.servers.map(draftOf),
          })
        : '',
    [data]
  );
  const body = (nextDrafts = drafts, nextTrash = trash) => ({
    trash: {
      autoApply: !!nextTrash?.autoApply,
      fillGaps: !!nextTrash?.fillGaps,
    },
    servers: (data?.servers ?? []).map(
      (s) => nextDrafts[keyOf(s)] ?? draftOf(s)
    ),
  });
  const dirty = !!data && JSON.stringify(body()) !== saved;

  const server = data?.servers.find((s) => keyOf(s) === selected);
  const draft = server ? drafts[keyOf(server)] : undefined;
  const app = server?.kind === 'radarr' ? 'Radarr' : 'Sonarr';

  const { data: formats } = useSWR<ServerFormat[]>(
    advanced && server?.managed
      ? `/api/v1/settings/quality/servers/${server.kind}/${server.serverId}/formats`
      : null
  );

  const save = async (nextDrafts = drafts, quiet = false) => {
    setSaving(true);
    try {
      const { data: next } = await axios.put<QualityView>(
        '/api/v1/settings/quality',
        body(nextDrafts)
      );
      await mutate(next, { revalidate: false });
      if (!quiet) {
        addToast(intl.formatMessage(messages.saved), {
          appearance: 'success',
          autoDismiss: true,
        });
      }
      return true;
    } catch (e) {
      addToast(
        intl.formatMessage(messages.saveFailed, { detail: errorOf(e) }),
        {
          appearance: 'error',
          autoDismiss: true,
        }
      );
      return false;
    } finally {
      setSaving(false);
    }
  };

  const edit = (change: (d: Draft) => Draft) => {
    if (!server || !draft) return;
    setDrafts({ ...drafts, [keyOf(server)]: change(draft) });
  };
  const adjust = <K extends keyof QualityAdjustments>(
    field: K,
    value: QualityAdjustments[K]
  ) =>
    edit((d) => ({ ...d, adjustments: { ...d.adjustments, [field]: value } }));

  const setManaged = async (managed: boolean) => {
    if (!server || !draft) return;
    const next = { ...drafts, [keyOf(server)]: { ...draft, managed } };
    setDrafts(next);
    await save(next, true);
  };

  const openPreview = async (restoreKept: boolean) => {
    if (dirty && !(await save(drafts, true))) return;
    setPreviewing({ restoreKept });
  };

  const keep = async () => {
    if (!server) return;
    try {
      const { data: kept } = await axios.post<{ kept: number }>(
        `/api/v1/settings/quality/servers/${server.kind}/${server.serverId}/keep`
      );
      addToast(intl.formatMessage(messages.keptChange, { count: kept.kept }), {
        appearance: 'info',
        autoDismiss: true,
      });
      mutate();
    } catch (e) {
      addToast(errorOf(e), { appearance: 'error', autoDismiss: true });
    }
  };

  const undo = async (entry: HistoryEntry) => {
    try {
      const { data: result } = await axios.post<{
        restored: number;
        removed: number;
        keptInUse: string[];
      }>(`/api/v1/settings/quality/history/${entry.id}/undo`);
      addToast(
        <span>
          {intl.formatMessage(messages.undoDone, result)}
          {result.keptInUse.length > 0 && (
            <>
              {' '}
              {intl.formatMessage(messages.undoKept, {
                names: intl.formatList(result.keptInUse, {
                  type: 'conjunction',
                }),
                count: result.keptInUse.length,
              })}
            </>
          )}
        </span>,
        { appearance: 'success', autoDismiss: true }
      );
      mutate();
    } catch (e) {
      addToast(
        intl.formatMessage(messages.undoFailed, { detail: errorOf(e) }),
        {
          appearance: 'error',
          autoDismiss: true,
        }
      );
    }
  };

  const checkTrash = async () => {
    setChecking(true);
    try {
      await axios.post('/api/v1/settings/quality/trash/check');
      addToast(intl.formatMessage(messages.checked), {
        appearance: 'info',
        autoDismiss: true,
      });
      mutate();
    } catch (e) {
      addToast(errorOf(e), { appearance: 'error', autoDismiss: true });
    } finally {
      setChecking(false);
    }
  };

  if (!data && !error) return <LoadingSpinner />;
  if (!data || !trash) return null;

  const statusBadge = (s: ServerView) => {
    const text = {
      'not-managed': intl.formatMessage(messages.notManaged),
      ready: intl.formatMessage(messages.ready),
      'in-sync': intl.formatMessage(messages.inSync),
      'update-ready': intl.formatMessage(messages.updateReady),
      changed: intl.formatMessage(messages.changed, {
        app: s.kind === 'radarr' ? 'Radarr' : 'Sonarr',
      }),
      kept: intl.formatMessage(messages.kept),
      unreachable: intl.formatMessage(messages.unreachable),
      unsupported: intl.formatMessage(messages.unsupported),
    }[s.status];
    const type = {
      'not-managed': 'dark',
      ready: 'primary',
      'in-sync': 'success',
      'update-ready': 'primary',
      changed: 'warning',
      kept: 'dark',
      unreachable: 'danger',
      unsupported: 'danger',
    }[s.status] as 'dark' | 'primary' | 'success' | 'warning' | 'danger';
    return <Badge badgeType={type}>{text}</Badge>;
  };

  const cardText = (s: ServerView) => {
    const lines: string[] = [];
    const list = (names: string[]) =>
      intl.formatList(names, { type: 'conjunction' });
    const changed = s.changed.filter((c) => !c.removed).map((c) => c.name);
    const removed = s.changed.filter((c) => c.removed).map((c) => c.name);
    if (s.status === 'not-managed')
      lines.push(intl.formatMessage(messages.notManagedText));
    if (s.status === 'unsupported')
      lines.push(intl.formatMessage(messages.unsupportedText));
    if (s.status === 'unreachable' && s.error) lines.push(s.error);
    if (s.status === 'ready')
      lines.push(intl.formatMessage(messages.readyText));
    if (s.status === 'update-ready')
      lines.push(intl.formatMessage(messages.updateText));
    if (changed.length) {
      lines.push(
        intl.formatMessage(messages.changedText, { names: list(changed), app })
      );
    }
    if (removed.length) {
      lines.push(
        intl.formatMessage(messages.removedText, {
          names: list(removed),
          count: removed.length,
          app,
        })
      );
    }
    if (s.kept.length) {
      lines.push(
        intl.formatMessage(messages.keptText, { names: list(s.kept), app })
      );
    }
    if (s.clashes.length) {
      lines.push(
        intl.formatMessage(messages.clashText, {
          names: list(s.clashes.map((n) => formatLabel(intl, '', n))),
        })
      );
    }
    return lines;
  };

  const sourceLine = (preset: PresetKey, source: PresetSource) => {
    if (source === 'off') return intl.formatMessage(messages.offText);
    if (source === 'seerr') return intl.formatMessage(messages.fromSeerr);
    return intl.formatMessage(messages.fromTrash);
  };
  const noTrashPreset = (preset: PresetKey) =>
    preset === 'sd' || preset === '720p';
  const otherManaged = data.servers.filter(
    (s) => s.managed && server && keyOf(s) !== keyOf(server)
  );

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.quality),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.quality)}</h3>
        <p className="description">
          {intl.formatMessage(messages.description)}
        </p>
      </div>

      <h4 className="mt-8 text-lg font-semibold text-gray-200">
        {intl.formatMessage(messages.trash)}
      </h4>
      <p className="description">
        {trash.checkedAt
          ? intl.formatMessage(messages.trashChecked, {
              when: relative(trash.checkedAt),
            })
          : intl.formatMessage(messages.trashNever)}
      </p>
      {trash.error && trash.failedAt && (
        <p className="mt-1 text-sm text-yellow-300 light:text-warning-text">
          {intl.formatMessage(messages.trashFailed, { error: trash.error })}
        </p>
      )}
      <div className="section !mb-0 !mt-2">
        <Row
          id="autoApply"
          label={intl.formatMessage(messages.autoApply)}
          tip={intl.formatMessage(messages.autoApplyTip)}
        >
          <input
            id="autoApply"
            type="checkbox"
            checked={trash.autoApply}
            onChange={(e) =>
              setTrash({ ...trash, autoApply: e.target.checked })
            }
          />
        </Row>
        <Row
          id="fillGaps"
          label={intl.formatMessage(messages.fillGaps)}
          tip={intl.formatMessage(messages.fillGapsTip)}
        >
          <input
            id="fillGaps"
            type="checkbox"
            checked={trash.fillGaps}
            onChange={(e) => setTrash({ ...trash, fillGaps: e.target.checked })}
          />
        </Row>
      </div>
      <div className="mt-4 flex max-w-6xl flex-wrap items-center gap-3">
        <Button buttonSize="sm" onClick={checkTrash} disabled={checking}>
          <ArrowPathIcon />
          <span>{intl.formatMessage(messages.checkNow)}</span>
        </Button>
        <a
          href="https://trash-guides.info"
          target="_blank"
          rel="noreferrer"
          className="text-xs text-gray-400 hover:underline"
        >
          {intl.formatMessage(messages.credit)}
        </a>
      </div>

      <h4 className="mt-10 text-lg font-semibold text-gray-200">
        {intl.formatMessage(messages.servers)}
      </h4>
      <p className="description">{intl.formatMessage(messages.serversTip)}</p>
      {!data.servers.length && (
        <p className="mt-4 text-sm text-gray-400">
          <Link
            href="/settings/services"
            className="text-indigo-400 hover:underline light:text-accent-text"
          >
            {intl.formatMessage(messages.noServers)}
          </Link>
        </p>
      )}
      <div className="mt-4 grid max-w-6xl grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        {data.servers.map((s) => {
          const on = keyOf(s) === selected;
          return (
            <button
              key={keyOf(s)}
              type="button"
              onClick={() => {
                setSelected(keyOf(s));
                setAdvanced(false);
              }}
              aria-pressed={on}
              className={`flex min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ring-1 sm:flex-none ${
                on
                  ? 'bg-gray-700 text-strong ring-gray-400'
                  : 'bg-gray-800 text-gray-300 ring-gray-700'
              }`}
            >
              <Logo
                kind={s.kind}
                className="service-logo h-5 w-5 flex-shrink-0"
              />
              <span className="truncate font-medium">{s.name}</span>
              <span
                className={`h-2 w-2 flex-shrink-0 rounded-full ${DOT[s.status]}`}
              />
            </button>
          );
        })}
      </div>

      {server && draft && (
        <>
          <div className="mt-4 max-w-6xl rounded-lg bg-gray-800 p-5 shadow ring-1 ring-gray-500">
            <div className="flex items-start gap-4">
              <Logo
                kind={server.kind}
                className="service-logo h-10 w-10 flex-shrink-0"
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-medium text-strong">{server.name}</h3>
                  {statusBadge(server)}
                </div>
                {cardText(server).map((line) => (
                  <p key={line} className="mt-1 text-sm text-gray-300">
                    {line}
                  </p>
                ))}
                {server.appliedAt && server.managed && (
                  <p className="mt-0.5 text-xs text-gray-400">
                    {intl.formatMessage(messages.appliedAt, {
                      when: relative(server.appliedAt),
                    })}
                  </p>
                )}
              </div>
            </div>
            {!server.managed && server.status !== 'unsupported' && (
              <p className="mt-4 text-sm text-gray-400">
                {intl.formatMessage(messages.manageTip)}
              </p>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              {!server.managed ? (
                <Button
                  buttonSize="sm"
                  buttonType="primary"
                  className="flex-1"
                  disabled={saving}
                  onClick={() => setManaged(true)}
                >
                  <span>{intl.formatMessage(messages.manage)}</span>
                </Button>
              ) : server.status === 'changed' || server.status === 'kept' ? (
                <>
                  <Button
                    buttonSize="sm"
                    buttonType="primary"
                    className="flex-1"
                    onClick={() => openPreview(true)}
                  >
                    <EyeIcon />
                    <span>{intl.formatMessage(messages.putBack)}</span>
                  </Button>
                  {server.status === 'changed' && (
                    <Button buttonSize="sm" className="flex-1" onClick={keep}>
                      <span>{intl.formatMessage(messages.keepChange)}</span>
                    </Button>
                  )}
                </>
              ) : server.status === 'unsupported' ||
                server.status === 'unreachable' ? null : (
                <Button
                  buttonSize="sm"
                  buttonType={
                    server.status === 'in-sync' && !dirty
                      ? 'default'
                      : 'primary'
                  }
                  className="flex-1"
                  disabled={saving}
                  onClick={() => openPreview(false)}
                >
                  <EyeIcon />
                  <span>{intl.formatMessage(messages.previewApply)}</span>
                </Button>
              )}
            </div>
            {server.managed && (
              <button
                type="button"
                className="mt-3 text-xs text-gray-400 hover:underline"
                title={intl.formatMessage(messages.stopManagingTip, { app })}
                onClick={() => setManaged(false)}
              >
                {intl.formatMessage(messages.stopManaging)}
              </button>
            )}
          </div>

          {server.managed && (
            <>
              <h4 className="mt-10 text-lg font-semibold text-gray-200">
                {intl.formatMessage(messages.presetsFor, {
                  server: server.name,
                })}
              </h4>
              <p className="description">
                {intl.formatMessage(messages.presetsTip)}
              </p>
              <div className="mt-4 max-w-6xl divide-y divide-gray-700 overflow-hidden rounded-lg ring-1 ring-gray-700">
                {PRESET_KEYS.map((preset) => {
                  const source = draft.presets[preset] ?? 'off';
                  const savedSource = server.presets[preset] ?? 'off';
                  const trashless = source === 'trash' && noTrashPreset(preset);
                  return (
                    <div
                      key={preset}
                      className="flex items-center gap-3 bg-gray-800 px-4 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 font-medium text-strong">
                          {presetLabel(intl, preset)}
                          {trashless && (
                            <Badge badgeType="dark">
                              {intl.formatMessage(
                                trash.fillGaps
                                  ? messages.filledIn
                                  : messages.noTrash
                              )}
                            </Badge>
                          )}
                        </div>
                        <div className="text-xs text-gray-400">
                          {sourceLine(preset, source)}
                        </div>
                        {savedSource !== 'off' &&
                          !(trashless && !trash.fillGaps) && (
                            <button
                              type="button"
                              className="mt-1 flex items-center gap-1 text-xs font-medium text-indigo-400 hover:underline light:text-accent-text"
                              onClick={() => setDescribing(preset)}
                            >
                              <DocumentMagnifyingGlassIcon className="h-4 w-4" />
                              {intl.formatMessage(messages.whatItDoes)}
                            </button>
                          )}
                      </div>
                      <select
                        className="!w-44 flex-none sm:!w-48"
                        aria-label={presetLabel(intl, preset)}
                        value={source}
                        onChange={(e) =>
                          edit((d) => ({
                            ...d,
                            presets: {
                              ...d.presets,
                              [preset]: e.target.value as PresetSource,
                            },
                          }))
                        }
                      >
                        <option value="seerr">
                          {intl.formatMessage(messages.sourceSeerr)}
                        </option>
                        <option value="trash">
                          {intl.formatMessage(messages.sourceTrash)}
                        </option>
                        <option value="off">
                          {intl.formatMessage(messages.sourceOff)}
                        </option>
                      </select>
                    </div>
                  );
                })}
              </div>

              <div className="mt-10 flex max-w-6xl flex-wrap items-end justify-between gap-3">
                <div>
                  <h4 className="text-lg font-semibold text-gray-200">
                    {intl.formatMessage(messages.adjustmentsFor, {
                      server: server.name,
                    })}
                  </h4>
                  <p className="description">
                    {intl.formatMessage(messages.adjustmentsTip)}
                  </p>
                </div>
                {otherManaged.length > 0 && (
                  <select
                    className="!w-56 flex-none"
                    aria-label={intl.formatMessage(messages.copyFrom)}
                    value=""
                    onChange={(e) => {
                      const from = drafts[e.target.value];
                      const fromServer = data.servers.find(
                        (s) => keyOf(s) === e.target.value
                      );
                      if (!from) return;
                      edit((d) => ({
                        ...d,
                        adjustments: { ...from.adjustments },
                        nudges: { ...from.nudges },
                        bandStep: from.bandStep,
                      }));
                      addToast(
                        intl.formatMessage(messages.copied, {
                          server: fromServer?.name,
                        }),
                        { appearance: 'info', autoDismiss: true }
                      );
                    }}
                  >
                    <option value="">
                      {intl.formatMessage(messages.copyFrom)}
                    </option>
                    {otherManaged.map((s) => (
                      <option key={keyOf(s)} value={keyOf(s)}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div className="section !mt-2">
                <div className="form-row">
                  <label htmlFor="preferUsenet" className="text-label">
                    {intl.formatMessage(messages.preferUsenet)}
                    <span className="label-tip">
                      {intl.formatMessage(
                        draft.adjustments.preferUsenet === 'always'
                          ? messages.preferAlwaysTip
                          : draft.adjustments.preferUsenet === 'none'
                            ? messages.preferNoneTip
                            : messages.preferEqualTip
                      )}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <select
                      id="preferUsenet"
                      value={draft.adjustments.preferUsenet}
                      onChange={(e) =>
                        adjust(
                          'preferUsenet',
                          e.target.value as QualityAdjustments['preferUsenet']
                        )
                      }
                    >
                      <option value="equal">
                        {intl.formatMessage(messages.preferEqual)}
                      </option>
                      <option value="always">
                        {intl.formatMessage(messages.preferAlways)}
                      </option>
                      <option value="none">
                        {intl.formatMessage(messages.preferNone)}
                      </option>
                    </select>
                    {draft.adjustments.preferUsenet === 'always' && (
                      <div className="mt-2 flex items-center gap-2">
                        <label htmlFor="torrentWait" className="text-gray-300">
                          {intl.formatMessage(messages.torrentsWait)}
                        </label>
                        <input
                          id="torrentWait"
                          type="number"
                          min={0}
                          max={168}
                          step={0.5}
                          style={{ flex: '0 0 5rem', width: '5rem' }}
                          value={draft.adjustments.torrentWaitHours}
                          onChange={(e) =>
                            adjust(
                              'torrentWaitHours',
                              Math.max(
                                0,
                                Math.min(168, Number(e.target.value) || 0)
                              )
                            )
                          }
                        />
                        <span className="text-gray-300">
                          {intl.formatMessage(messages.hours)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="fileSize" className="text-label">
                    {intl.formatMessage(messages.fileSize)}
                    <span className="label-tip">
                      {server.kind === 'sonarr' &&
                      server.sizesOnProfile === false
                        ? intl.formatMessage(messages.fileSizeSonarr4)
                        : intl.formatMessage(messages.fileSizeTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <select
                      id="fileSize"
                      value={draft.adjustments.fileSize}
                      disabled={
                        server.kind === 'sonarr' &&
                        server.sizesOnProfile === false
                      }
                      onChange={(e) =>
                        adjust(
                          'fileSize',
                          e.target.value as QualityAdjustments['fileSize']
                        )
                      }
                    >
                      <option value="small">
                        {intl.formatMessage(messages.sizeSmall)}
                      </option>
                      <option value="balanced">
                        {intl.formatMessage(messages.sizeBalanced)}
                      </option>
                      <option value="best">
                        {intl.formatMessage(messages.sizeBest)}
                      </option>
                    </select>
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="languages" className="text-label">
                    {intl.formatMessage(messages.languages)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.languagesTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <select
                      id="languages"
                      value={draft.adjustments.languages}
                      onChange={(e) =>
                        adjust(
                          'languages',
                          e.target.value as QualityAdjustments['languages']
                        )
                      }
                    >
                      <option value="english-or-original">
                        {intl.formatMessage(messages.langEnglishOriginal)}
                      </option>
                      <option value="original">
                        {intl.formatMessage(messages.langOriginal)}
                      </option>
                      <option value="any">
                        {intl.formatMessage(messages.langAny)}
                      </option>
                    </select>
                  </div>
                </div>
                {(
                  [
                    ['hdr', messages.hdr, messages.hdrTip],
                    ['x265At1080p', messages.x265, messages.x265Tip],
                    [
                      'dualAudioAnime',
                      messages.dualAudio,
                      messages.dualAudioTip,
                    ],
                    ...(server.kind === 'sonarr'
                      ? ([
                          [
                            'singleEpisodes',
                            messages.singleEpisodes,
                            messages.singleEpisodesTip,
                          ],
                        ] as const)
                      : []),
                    [
                      'burnedInLastResort',
                      messages.burnedIn,
                      messages.burnedInTip,
                    ],
                    ['av1LastResort', messages.av1, messages.av1Tip],
                  ] as const
                ).map(([field, label, tip]) => (
                  <Row
                    key={field}
                    id={field}
                    label={intl.formatMessage(label)}
                    tip={intl.formatMessage(tip)}
                  >
                    <input
                      id={field}
                      type="checkbox"
                      checked={!!draft.adjustments[field]}
                      onChange={(e) => adjust(field, e.target.checked)}
                    />
                  </Row>
                ))}
              </div>

              <div className="max-w-6xl rounded-lg bg-gray-800 ring-1 ring-gray-700">
                <button
                  type="button"
                  className="flex w-full items-center justify-between px-4 py-3 text-left"
                  aria-expanded={advanced}
                  onClick={() => setAdvanced(!advanced)}
                >
                  <div>
                    <div className="font-medium text-strong">
                      {intl.formatMessage(messages.advanced)}
                    </div>
                    <div className="text-xs text-gray-400">
                      {intl.formatMessage(messages.advancedTip)}
                    </div>
                  </div>
                  <ChevronDownIcon
                    className={`h-5 w-5 flex-shrink-0 text-gray-400 transition ${advanced ? 'rotate-180' : ''}`}
                  />
                </button>
                {advanced && (
                  <div className="divide-y divide-gray-700 border-t border-gray-700">
                    <div className="flex items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <label
                          htmlFor="bandStep"
                          className="text-sm text-strong"
                        >
                          {intl.formatMessage(messages.bandStep)}
                        </label>
                        <div className="text-xs text-gray-400">
                          {intl.formatMessage(messages.bandStepTip)}
                        </div>
                      </div>
                      <select
                        id="bandStep"
                        className="!w-28 flex-none"
                        value={draft.bandStep}
                        onChange={(e) =>
                          edit((d) => ({
                            ...d,
                            bandStep: Number(e.target.value) as BandStep,
                          }))
                        }
                      >
                        {BAND_STEPS.map((step) => (
                          <option key={step} value={step}>
                            {step}
                          </option>
                        ))}
                      </select>
                    </div>
                    {!formats ? (
                      <div className="px-4 py-3">
                        <LoadingSpinner />
                      </div>
                    ) : (
                      formats.map((format) => (
                        <div
                          key={format.key}
                          className="flex items-center gap-3 px-4 py-2.5"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="text-sm text-strong">
                              {formatLabel(intl, format.key, format.name)}
                            </div>
                            <div className="text-xs text-gray-400">
                              {intl.formatList(
                                [
                                  format.origin === 'trash'
                                    ? 'TRaSH Guides'
                                    : 'Seerr AI',
                                  ...format.presets.map((p) =>
                                    presetLabel(intl, p)
                                  ),
                                ],
                                { type: 'unit' }
                              )}
                            </div>
                          </div>
                          <select
                            className="!w-40 flex-none"
                            aria-label={formatLabel(
                              intl,
                              format.key,
                              format.name
                            )}
                            value={draft.nudges[format.key] ?? ''}
                            onChange={(e) =>
                              edit((d) => {
                                const nudges = { ...d.nudges };
                                if (e.target.value)
                                  nudges[format.key] = e.target.value as Nudge;
                                else delete nudges[format.key];
                                return { ...d, nudges };
                              })
                            }
                          >
                            <option value="">
                              {intl.formatMessage(messages.asSet)}
                            </option>
                            <option value="up">
                              {intl.formatMessage(messages.up)}
                            </option>
                            <option value="down">
                              {intl.formatMessage(messages.down)}
                            </option>
                            <option value="never">
                              {intl.formatMessage(messages.never)}
                            </option>
                          </select>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
              <p className="mt-3 max-w-6xl text-sm text-gray-400">
                {intl.formatMessage(messages.stepDown)}{' '}
                <Link
                  href="/settings/backfill"
                  className="text-indigo-400 hover:underline light:text-accent-text"
                >
                  {intl.formatMessage(messages.stepDownLink)}
                </Link>
              </p>
            </>
          )}
        </>
      )}

      <h4 className="mt-10 text-lg font-semibold text-gray-200">
        {intl.formatMessage(messages.history)}
      </h4>
      {!data.history.length ? (
        <p className="mt-2 text-sm text-gray-400">
          {intl.formatMessage(messages.noHistory)}
        </p>
      ) : (
        <ul className="mt-4 max-w-6xl divide-y divide-gray-700 overflow-hidden rounded-lg ring-1 ring-gray-700">
          {data.history.map((entry) => (
            <li
              key={entry.id}
              className="flex items-center gap-3 bg-gray-800 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm text-strong">
                  {entry.serverName} ·{' '}
                  {entry.trash
                    ? intl.formatMessage(messages.historyTrash)
                    : intl.formatMessage(messages.historyLine, {
                        created: entry.created,
                        updated: entry.updated,
                      })}
                  {entry.moved > 0 &&
                    ` · ${intl.formatMessage(messages.historyMoved, { count: entry.moved })}`}
                </div>
                <div className="text-xs text-gray-400">
                  {relative(entry.createdAt)}
                  {entry.by &&
                    ` · ${intl.formatMessage(messages.historyBy, { name: entry.by })}`}
                </div>
              </div>
              {entry.undoneAt ? (
                <Badge badgeType="dark">
                  {intl.formatMessage(messages.undone)}
                </Badge>
              ) : (
                entry.canUndo && (
                  <Button buttonSize="sm" onClick={() => undo(entry)}>
                    <ArrowUturnLeftIcon />
                    <span>{intl.formatMessage(messages.undo)}</span>
                  </Button>
                )
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="actions">
        <div className="flex flex-wrap items-center justify-end gap-3">
          {dirty && (
            <span className="text-sm text-yellow-300 light:text-warning-text">
              {intl.formatMessage(messages.unsaved)}
            </span>
          )}
          <Button
            buttonType="primary"
            disabled={saving || !dirty}
            onClick={() => save()}
          >
            <ArrowDownOnSquareIcon />
            <span>{intl.formatMessage(globalMessages.save)}</span>
          </Button>
        </div>
      </div>

      {previewing && server && (
        <PreviewModal
          kind={server.kind}
          serverId={server.serverId}
          serverName={server.name}
          restoreKept={previewing.restoreKept}
          onClose={() => setPreviewing(null)}
          onApplied={() => {
            setPreviewing(null);
            mutate();
          }}
        />
      )}
      {server && (
        <WhatItDoes
          kind={server.kind}
          serverId={server.serverId}
          serverName={server.name}
          preset={describing}
          onClose={() => setDescribing(null)}
        />
      )}
    </>
  );
};

export default SettingsQuality;
