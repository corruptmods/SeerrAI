import { ProgressBar } from '@app/components/Backfill/shared';
import Badge from '@app/components/Common/Badge';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import { postAndFollow } from '@app/components/Settings/SettingsQuality/jobs';
import {
  formatLabel,
  presetLabel,
  profileLabel,
} from '@app/components/Settings/SettingsQuality/labels';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { ArrowDownIcon, ArrowUpIcon } from '@heroicons/react/20/solid';
import type {
  ApplyProgress,
  ApplyStep,
  ChangeDetail,
  Preview,
  PreviewChange,
} from '@server/lib/quality/engine';
import type { FormatEffect } from '@server/lib/quality/plan';
import type { ArrKind, PresetKey } from '@server/lib/quality/types';
import axios from 'axios';
import { useCallback, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Settings.SettingsQuality.Preview', {
  title: 'Preview: {server}',
  first: 'First setup. Nothing changes until you apply.',
  later: 'Nothing changes until you apply.',
  apply: 'Apply',
  applying: 'Applying…',
  create: 'Create',
  update: 'Update',
  putBack: 'Put back',
  kept: 'Kept as edited',
  unchanged: '{count, plural, one {# more unchanged} other {# more unchanged}}',
  shared: 'Shared setting',
  delay: 'Delay profile',
  delayNote: 'Affects every profile on this server.',
  leftAlone: 'Left alone',
  ownProfiles:
    '{count, plural, one {Your # own profile} other {Your # own profiles}}, and the titles on them',
  moveHeading: 'Move titles onto Seerr AI’s profiles',
  moveTip: 'Off unless you choose. Undo moves them back.',
  stay: 'Leave {count, plural, one {# title} other {# titles}} here',
  moveTo: 'Move to {profile}',
  nothing: 'Nothing to change.',
  noTrash:
    '{preset}: TRaSH Guides has no preset for it. Turn on Fill gaps with Seerr AI, or choose Seerr AI.',
  trashMissing: '{preset}: waiting for TRaSH Guides to be fetched.',
  score: '{format}: {from} → {to}',
  cutoff: 'Upgrades stop at {to} (was {from})',
  qualities: 'Qualities it takes changed',
  sizes: 'File sizes changed',
  minScore: 'Lowest score taken: {from} → {to}',
  rules: 'What it matches changed',
  protocol: 'Prefers {to} (was {from})',
  torrentDelay:
    'Torrents wait {to, plural, one {# minute} other {# minutes}} (was {from})',
  usenet: 'usenet',
  torrent: 'torrent',
  effectNever: 'Avoid: never grabbed',
  effectLastResort: 'Avoid: only as a last resort',
  effectLower: 'Avoid: less likely to be grabbed',
  effectPrefer: 'Prefer: more likely to be grabbed',
  effectNone: 'No effect',
  effectIn: '{effect} ({presets})',
  requests: 'Where new requests go',
  stepFormats: 'Writing formats',
  stepProfiles: 'Writing profiles',
  stepTitles: 'Moving titles',
  progressStarting: 'Applying… this can take a few minutes on a big server.',
  progressCount: '{done} of {total}',
  requestsNote:
    'Seerr AI’s own setting: each server’s quality profile in Settings → Services.',
  requestsMain: 'New requests use {to} (was {from})',
  requestsMainNew: 'New requests use {to}',
  requestsAnime: 'New anime requests use {to} (was {from})',
  requestsAnimeNew: 'New anime requests use {to}',
  applied:
    'Applied: {created, plural, one {# created} other {# created}}, {updated, plural, one {# updated} other {# updated}}.',
  appliedMoved:
    'Applied: {created, plural, one {# created} other {# created}}, {updated, plural, one {# updated} other {# updated}}, {moved, plural, one {# title moved} other {# titles moved}}.',
  failed: 'Could not apply: {detail}',
  previewFailed: 'Could not make the preview: {detail}',
});

interface PreviewModalProps {
  kind: ArrKind;
  serverId: number;
  serverName: string;
  restoreKept?: boolean;
  onClose: () => void;
  onApplied: () => void;
}

const errorOf = (e: unknown) =>
  (axios.isAxiosError(e) && e.response?.data?.message) ||
  (e instanceof Error ? e.message : String(e));

const PreviewModal = ({
  kind,
  serverId,
  serverName,
  restoreKept,
  onClose,
  onApplied,
}: PreviewModalProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ApplyProgress | null>(null);
  const [moves, setMoves] = useState<Record<number, PresetKey | ''>>({});

  const load = useCallback(
    (live: () => boolean = () => true) =>
      axios
        .post<Preview>(
          `/api/v1/settings/quality/servers/${kind}/${serverId}/preview`,
          restoreKept ? { restoreKept: true } : {}
        )
        .then(({ data }) => live() && setPreview(data))
        .catch((e) => {
          addToast(
            intl.formatMessage(messages.previewFailed, { detail: errorOf(e) }),
            { appearance: 'error', autoDismiss: true }
          );
          onClose();
        }),
    // Made when the preview opens, and again if it is out of date.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  useEffect(() => {
    let live = true;
    load(() => live);
    return () => {
      live = false;
    };
  }, [load]);

  const protocol = (p: string) =>
    intl.formatMessage(p === 'usenet' ? messages.usenet : messages.torrent);

  const detailText = (detail: ChangeDetail) => {
    switch (detail.kind) {
      case 'score':
        return intl.formatMessage(messages.score, {
          format: formatLabel(intl, '', detail.format),
          from: intl.formatNumber(detail.from),
          to: intl.formatNumber(detail.to),
        });
      case 'cutoff':
        return intl.formatMessage(messages.cutoff, detail);
      case 'qualities':
        return intl.formatMessage(messages.qualities);
      case 'sizes':
        return intl.formatMessage(messages.sizes);
      case 'min-score':
        return intl.formatMessage(messages.minScore, {
          from: intl.formatNumber(detail.from),
          to: intl.formatNumber(detail.to),
        });
      case 'rules':
        return intl.formatMessage(messages.rules);
      case 'protocol':
        return intl.formatMessage(messages.protocol, {
          from: protocol(detail.from),
          to: protocol(detail.to),
        });
      case 'torrent-delay':
        return intl.formatMessage(messages.torrentDelay, detail);
      case 'requests': {
        const to = profileLabel(intl, detail.preset, detail.to);
        if (detail.which === 'main') {
          return detail.from
            ? intl.formatMessage(messages.requestsMain, {
                to,
                from: detail.from,
              })
            : intl.formatMessage(messages.requestsMainNew, { to });
        }
        return detail.from
          ? intl.formatMessage(messages.requestsAnime, {
              to,
              from: detail.from,
            })
          : intl.formatMessage(messages.requestsAnimeNew, { to });
      }
    }
  };

  const nameOf = (change: PreviewChange) =>
    change.itemKind === 'profile'
      ? profileLabel(intl, change.key, change.name)
      : change.itemKind === 'delay'
        ? intl.formatMessage(messages.delay)
        : change.itemKind === 'requests'
          ? intl.formatMessage(messages.requests)
          : formatLabel(intl, change.key, change.name);

  /**
   * What a format does to a release that matches it: avoided or preferred,
   * once when every profile agrees, or profile by profile.
   */
  const effectsOf = (change: PreviewChange) => {
    if (change.itemKind !== 'format' || !change.effects?.length) return null;
    const groups = new Map<FormatEffect, PresetKey[]>();
    for (const { preset, effect } of change.effects) {
      groups.set(effect, [...(groups.get(effect) ?? []), preset]);
    }
    const look: Record<
      FormatEffect,
      { text: string; className: string; up?: boolean; down?: boolean }
    > = {
      never: {
        text: intl.formatMessage(messages.effectNever),
        className: 'text-red-400 light:text-danger-text',
        down: true,
      },
      'last-resort': {
        text: intl.formatMessage(messages.effectLastResort),
        className: 'text-yellow-300 light:text-warning-text',
        down: true,
      },
      lower: {
        text: intl.formatMessage(messages.effectLower),
        className: 'text-yellow-300 light:text-warning-text',
        down: true,
      },
      prefer: {
        text: intl.formatMessage(messages.effectPrefer),
        className: 'text-green-400 light:text-success-text',
        up: true,
      },
      none: {
        text: intl.formatMessage(messages.effectNone),
        className: 'text-gray-400',
      },
    };
    const order: FormatEffect[] = [
      'never',
      'last-resort',
      'lower',
      'prefer',
      'none',
    ];
    const all = groups.size === 1;
    return (
      <ul className="mt-1 space-y-0.5">
        {order
          .filter((effect) => groups.has(effect))
          .map((effect) => {
            const { text, className, up, down } = look[effect];
            return (
              <li
                key={effect}
                className={`flex items-start gap-1 text-sm ${className}`}
              >
                {up && <ArrowUpIcon className="mt-0.5 h-4 w-4 flex-none" />}
                {down && <ArrowDownIcon className="mt-0.5 h-4 w-4 flex-none" />}
                <span>
                  {all
                    ? text
                    : intl.formatMessage(messages.effectIn, {
                        effect: text,
                        presets: intl.formatList(
                          (groups.get(effect) ?? []).map((preset) =>
                            presetLabel(intl, preset)
                          ),
                          { type: 'conjunction' }
                        ),
                      })}
                </span>
              </li>
            );
          })}
      </ul>
    );
  };

  const badgeOf = (change: PreviewChange) => {
    if (change.itemKind === 'delay') {
      return (
        <Badge badgeType="warning">{intl.formatMessage(messages.shared)}</Badge>
      );
    }
    switch (change.action) {
      case 'create':
        return (
          <Badge badgeType="success">
            {intl.formatMessage(messages.create)}
          </Badge>
        );
      case 'put-back':
        return (
          <Badge badgeType="warning">
            {intl.formatMessage(messages.putBack)}
          </Badge>
        );
      case 'kept':
        return (
          <Badge badgeType="dark">{intl.formatMessage(messages.kept)}</Badge>
        );
      default:
        return (
          <Badge badgeType="primary">
            {intl.formatMessage(messages.update)}
          </Badge>
        );
    }
  };

  const shown = (preview?.changes ?? []).filter(
    (c) => c.action !== 'unchanged'
  );
  const unchanged = (preview?.changes ?? []).length - shown.length;
  // Profiles first, then where requests go and the shared delay profile,
  // then formats.
  const order = { profile: 0, requests: 1, delay: 2, format: 3 };
  shown.sort((a, b) => order[a.itemKind] - order[b.itemKind]);
  const presets = (preview?.changes ?? [])
    .filter((c) => c.itemKind === 'profile')
    .map((c) => c.key as PresetKey);

  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const move = Object.entries(moves)
        .filter(([, preset]) => preset)
        .map(([from, preset]) => ({
          fromProfileId: Number(from),
          preset: preset as PresetKey,
        }));
      const data = await postAndFollow<{
        created: number;
        updated: number;
        moved: number;
      }>(
        `/api/v1/settings/quality/servers/${kind}/${serverId}/apply`,
        {
          ...(move.length ? { move } : {}),
          ...(restoreKept ? { restoreKept: true } : {}),
          token: preview.token,
        },
        setProgress
      );
      addToast(
        intl.formatMessage(
          data.moved ? messages.appliedMoved : messages.applied,
          data
        ),
        { appearance: 'success', autoDismiss: true }
      );
      onApplied();
    } catch (e) {
      addToast(intl.formatMessage(messages.failed, { detail: errorOf(e) }), {
        appearance: 'error',
        autoDismiss: true,
      });
      // Something changed since the preview: show what applying does now.
      if (axios.isAxiosError(e) && e.response?.data?.code === 'stale') {
        setPreview(null);
        await load();
      }
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const stepText: Record<ApplyStep, string> = {
    formats: intl.formatMessage(messages.stepFormats),
    profiles: intl.formatMessage(messages.stepProfiles),
    delay: intl.formatMessage(messages.delay),
    requests: intl.formatMessage(messages.requests),
    titles: intl.formatMessage(messages.stepTitles),
  };

  const withTitles = (preview?.ownProfiles ?? []).filter((p) => p.titles > 0);

  return (
    <Transition as="div" appear show>
      <Modal
        title={intl.formatMessage(messages.title, { server: serverName })}
        subTitle={intl.formatMessage(
          preview?.first ? messages.first : messages.later
        )}
        okText={intl.formatMessage(busy ? messages.applying : messages.apply)}
        okButtonType="primary"
        okDisabled={
          !preview ||
          busy ||
          (!shown.length && !Object.values(moves).some(Boolean))
        }
        onOk={apply}
        onCancel={onClose}
        loading={!preview}
        showCloseButton
      >
        {!preview ? (
          <LoadingSpinner />
        ) : (
          <div className="space-y-3 text-sm">
            {preview.skipped.map((skip) => (
              <p
                key={skip.preset}
                className="text-yellow-300 light:text-warning-text"
              >
                {intl.formatMessage(
                  skip.reason === 'no-trash'
                    ? messages.noTrash
                    : messages.trashMissing,
                  { preset: presetLabel(intl, skip.preset) }
                )}
              </p>
            ))}
            {!shown.length && (
              <p className="text-gray-400">
                {intl.formatMessage(messages.nothing)}
              </p>
            )}
            <ul className="space-y-2">
              {shown.map((change) => (
                <li
                  key={`${change.itemKind}:${change.key}`}
                  className="rounded-md bg-gray-900/60 p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {badgeOf(change)}
                    <span className="font-medium text-strong">
                      {nameOf(change)}
                    </span>
                  </div>
                  {effectsOf(change)}
                  {change.itemKind === 'delay' && (
                    <p className="mt-1 text-gray-400">
                      {intl.formatMessage(messages.delayNote)}
                    </p>
                  )}
                  {change.itemKind === 'requests' && (
                    <p className="mt-1 text-gray-400">
                      {intl.formatMessage(messages.requestsNote)}
                    </p>
                  )}
                  {change.details.length > 0 && (
                    <ul className="mt-1 list-inside list-disc text-gray-400">
                      {change.details.slice(0, 8).map((detail, i) => (
                        <li key={i}>{detailText(detail)}</li>
                      ))}
                      {change.details.length > 8 && <li>…</li>}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
            {unchanged > 0 && (
              <p className="text-xs text-gray-400">
                {intl.formatMessage(messages.unchanged, { count: unchanged })}
              </p>
            )}
            {preview.ownProfiles.length > 0 && (
              <div className="rounded-md bg-gray-900/60 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge badgeType="dark">
                    {intl.formatMessage(messages.leftAlone)}
                  </Badge>
                  <span className="font-medium text-strong">
                    {intl.formatMessage(messages.ownProfiles, {
                      count: preview.ownProfiles.length,
                    })}
                  </span>
                </div>
              </div>
            )}
            {withTitles.length > 0 && presets.length > 0 && (
              <div className="pt-1">
                <div className="font-medium text-strong">
                  {intl.formatMessage(messages.moveHeading)}
                </div>
                <p className="text-xs text-gray-400">
                  {intl.formatMessage(messages.moveTip)}
                </p>
                <div className="mt-2 space-y-2">
                  {withTitles.map((own) => (
                    <div
                      key={own.id}
                      className="flex flex-wrap items-center gap-2"
                    >
                      <span className="min-w-0 flex-1 break-words text-gray-300">
                        {own.name}
                      </span>
                      <select
                        className="!w-56 flex-none"
                        aria-label={own.name}
                        value={moves[own.id] ?? ''}
                        onChange={(e) =>
                          setMoves({
                            ...moves,
                            [own.id]: e.target.value as PresetKey | '',
                          })
                        }
                      >
                        <option value="">
                          {intl.formatMessage(messages.stay, {
                            count: own.titles,
                          })}
                        </option>
                        {presets.map((preset) => (
                          <option key={preset} value={preset}>
                            {intl.formatMessage(messages.moveTo, {
                              profile: `Seerr AI · ${presetLabel(intl, preset)}`,
                            })}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        {busy && (
          <div className="mt-4 space-y-1.5" aria-live="polite">
            <div className="flex flex-wrap justify-between gap-x-3 text-xs text-gray-300">
              <span>
                {progress
                  ? stepText[progress.step]
                  : intl.formatMessage(messages.progressStarting)}
              </span>
              {progress && progress.total > 0 && (
                <span>
                  {intl.formatMessage(messages.progressCount, {
                    done: progress.done,
                    total: progress.total,
                  })}
                </span>
              )}
            </div>
            <ProgressBar
              value={
                progress && progress.total > 0
                  ? (progress.done / progress.total) * 100
                  : 3
              }
            />
          </div>
        )}
      </Modal>
    </Transition>
  );
};

export default PreviewModal;
