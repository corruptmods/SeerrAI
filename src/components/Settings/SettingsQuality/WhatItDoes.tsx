import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import SlideOver from '@app/components/Common/SlideOver';
import {
  formatLabel,
  presetLabel,
} from '@app/components/Settings/SettingsQuality/labels';
import defineMessages from '@app/utils/defineMessages';
import type {
  DescribedFormat,
  Description,
  RecentGrab,
  TryResult,
} from '@server/lib/quality/describe';
import type { ArrKind, PresetKey } from '@server/lib/quality/types';
import axios from 'axios';
import type { FormEvent } from 'react';
import { useState } from 'react';
import { FormattedRelativeTime, useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.Settings.SettingsQuality.WhatItDoes',
  {
    inShort: 'In short',
    summaryStart:
      'Takes anything from {lowest} up, and keeps upgrading until it has {goal}.',
    summaryOne: 'Takes {goal} only.',
    summaryGroups: 'Better release groups come first.',
    summaryUsenet: 'When two releases are as good, usenet wins.',
    summaryNever: 'It never takes {formats}.',
    builtFrom: 'Built from',
    sourceSeerr: 'Seerr AI’s preset',
    sourceTrash: 'TRaSH Guides: {name}',
    filledIn: 'Filled in by Seerr AI: TRaSH Guides has no {preset} preset',
    bandStep: 'Band step {step}.',
    noBands: 'Exact scores: no bands.',
    notApplied: 'Not applied yet: this is what it will be.',
    qualities: 'Qualities, best first',
    goal: 'Goal',
    lowest: 'Lowest it takes',
    mbMin: 'up to {mb} MB a minute',
    filmCap: 'A film over {gb} GB is a last resort.',
    notAllowed: 'Not allowed: {list}',
    prefers: 'What it prefers',
    best: 'Best',
    better: 'Preferred',
    nothing: 'Counts for nothing',
    nothingTip: 'So it can’t beat a usenet release that is otherwise as good.',
    lastResort: 'Last resort',
    lastResortTip: 'Only taken when nothing else is out.',
    never: 'Never takes',
    rounded: '{from} → {to}, rounded to the step',
    nudgedUp: 'You moved it up a band',
    nudgedDown: 'You moved it down a band',
    nudgedNever: 'You set it to never',
    x265Allowed: 'You allowed x265 at 1080p',
    av1LastResort: 'You made AV1 a last resort',
    av1Allowed: 'You allowed AV1',
    hdrOff: 'You turned HDR off',
    conflict: 'Can’t be used with another format TRaSH Guides lists',
    tie: 'When two releases tie',
    tie1: 'Better quality on the list above',
    tie2: 'Higher score',
    tie3usenet: 'Usenet before torrent (the delay profile)',
    tie3torrent: 'Torrent before usenet (the delay profile)',
    tie4: 'The indexer you rank higher',
    torrentsWait:
      'Torrents wait {minutes, plural, one {# minute} other {# minutes}}, so usenet gets the first chance.',
    try: 'Try a release name',
    tryButton: 'Try',
    tryPlaceholder: 'Paste a release name',
    grab: 'Would grab',
    grabScore: 'Score {score}.',
    noGrab: 'Would not grab',
    quality: '{quality} isn’t one of its qualities.',
    neverFormat: 'Matches {format}, which it never takes.',
    tooLow: 'Scores {score}; the lowest it takes is {min}.',
    notAppliedTry: 'Apply this server first to try names against it.',
    languageUnknown: 'Its language can’t be told from the name.',
    matched: 'Matches: {list}',
    tryFailed: 'Could not try it: {detail}',
    recent: 'Recent grabs',
    noGrabs: 'Nothing grabbed onto this profile yet.',
    usenet: 'Usenet',
    torrent: 'Torrent',
    score: 'Score {score}',
    bySeerrTie:
      'Seerr AI grabbed it: it tied with a release over the other protocol, and won.',
    bySeerr: 'Seerr AI grabbed it.',
    byArr: '{app} grabbed it; {app} doesn’t record what else it saw.',
    close: 'Close',
  }
);

const SOURCE_TAG: Record<DescribedFormat['origin'], string> = {
  seerr: 'Seerr AI',
  trash: 'TRaSH',
  you: 'You',
};

const SourceTag = ({ origin }: { origin: DescribedFormat['origin'] }) => (
  <span
    className={`rounded px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide ${
      origin === 'you'
        ? 'bg-indigo-500/20 text-indigo-200 light:text-accent-text'
        : 'bg-gray-700/60 text-gray-300'
    }`}
  >
    {SOURCE_TAG[origin]}
  </span>
);

const Section = ({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) => (
  <div className="mt-6">
    <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
      {title}
    </h4>
    {children}
  </div>
);

interface WhatItDoesProps {
  kind: ArrKind;
  serverId: number;
  serverName: string;
  preset: PresetKey | null;
  onClose: () => void;
}

const errorOf = (e: unknown) =>
  (axios.isAxiosError(e) && e.response?.data?.message) ||
  (e instanceof Error ? e.message : String(e));

const WhatItDoes = ({
  kind,
  serverId,
  serverName,
  preset,
  onClose,
}: WhatItDoesProps) => {
  const intl = useIntl();
  const base = preset
    ? `/api/v1/settings/quality/servers/${kind}/${serverId}/presets/${preset}`
    : null;
  const { data: d, error } = useSWR<Description>(base);
  const { data: grabs } = useSWR<RecentGrab[]>(base ? `${base}/grabs` : null);
  const [title, setTitle] = useState('');
  const [tried, setTried] = useState<TryResult | null>(null);
  const [tryError, setTryError] = useState<string | null>(null);
  const [trying, setTrying] = useState(false);
  const app = kind === 'radarr' ? 'Radarr' : 'Sonarr';

  const tryIt = async (e: FormEvent) => {
    e.preventDefault();
    if (!base || title.trim().length < 3) return;
    setTrying(true);
    setTryError(null);
    try {
      const { data } = await axios.post<TryResult>(`${base}/try`, {
        title: title.trim(),
      });
      setTried(data);
    } catch (err) {
      setTried(null);
      setTryError(
        intl.formatMessage(messages.tryFailed, { detail: errorOf(err) })
      );
    } finally {
      setTrying(false);
    }
  };

  const label = (f: DescribedFormat) => formatLabel(intl, f.key, f.name);

  const changeNote = (f: DescribedFormat) =>
    f.changes
      .map((c) => {
        switch (c.kind) {
          case 'rounded':
            return intl.formatMessage(messages.rounded, {
              from: intl.formatNumber(c.from),
              to: intl.formatNumber(f.score),
            });
          case 'nudged':
            return intl.formatMessage(
              c.nudge === 'up'
                ? messages.nudgedUp
                : c.nudge === 'down'
                  ? messages.nudgedDown
                  : messages.nudgedNever
            );
          case 'x265-allowed':
            return intl.formatMessage(messages.x265Allowed);
          case 'av1':
            return intl.formatMessage(
              c.to === 'last-resort'
                ? messages.av1LastResort
                : messages.av1Allowed
            );
          case 'hdr-off':
            return intl.formatMessage(messages.hdrOff);
          case 'conflict':
            return intl.formatMessage(messages.conflict);
        }
      })
      .join(' · ');

  const formatRow = (f: DescribedFormat) => {
    const note = changeNote(f);
    return (
      <li key={f.key} className="flex flex-wrap items-center gap-x-2">
        <span className="text-gray-300">{label(f)}</span>
        <SourceTag origin={f.origin} />
        {note && <span className="w-full text-xs text-gray-400">{note}</span>}
      </li>
    );
  };

  const summary = () => {
    if (!d) return '';
    const goal = d.qualities.find((q) => q.goal)?.name ?? d.qualities[0]?.name;
    const lowest = d.qualities[d.qualities.length - 1]?.name;
    const parts = [
      d.qualities.length > 1
        ? intl.formatMessage(messages.summaryStart, { lowest, goal })
        : intl.formatMessage(messages.summaryOne, { goal }),
    ];
    if (d.bands.length > 1)
      parts.push(intl.formatMessage(messages.summaryGroups));
    if (d.banding && d.preferredProtocol === 'usenet') {
      parts.push(intl.formatMessage(messages.summaryUsenet));
    }
    if (d.never.length) {
      parts.push(
        intl.formatMessage(messages.summaryNever, {
          formats: intl.formatList(d.never.slice(0, 3).map(label), {
            type: 'disjunction',
          }),
        })
      );
    }
    return parts.join(' ');
  };

  const verdict = (result: TryResult) => {
    const r = result.result;
    switch (r.verdict) {
      case 'grab':
        return {
          ok: true,
          text: intl.formatMessage(messages.grabScore, {
            score: intl.formatNumber(r.score),
          }),
        };
      case 'quality':
        return {
          ok: false,
          text: intl.formatMessage(messages.quality, {
            quality: r.quality ?? '?',
          }),
        };
      case 'never':
        return {
          ok: false,
          text: intl.formatMessage(messages.neverFormat, {
            format: formatLabel(intl, '', r.format),
          }),
        };
      case 'too-low':
        return {
          ok: false,
          text: intl.formatMessage(messages.tooLow, {
            score: intl.formatNumber(r.score),
            min: intl.formatNumber(r.min),
          }),
        };
      default:
        return { ok: false, text: intl.formatMessage(messages.notAppliedTry) };
    }
  };

  return (
    <SlideOver
      show={!!preset}
      title={preset ? `Seerr AI · ${presetLabel(intl, preset)}` : ''}
      subText={serverName}
      onClose={onClose}
      footer={
        <Button buttonSize="sm" className="w-full" onClick={onClose}>
          <span>{intl.formatMessage(messages.close)}</span>
        </Button>
      }
    >
      {!d && !error && <LoadingSpinner />}
      {error && <p className="text-sm text-red-300">{errorOf(error)}</p>}
      {d && (
        <div className="text-sm">
          <p className="text-gray-200">{summary()}</p>
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-gray-400">
            <span>{intl.formatMessage(messages.builtFrom)}</span>
            <span className="text-gray-300">
              {d.source === 'trash'
                ? intl.formatMessage(messages.sourceTrash, {
                    name: d.trashName,
                  })
                : d.filledIn
                  ? intl.formatMessage(messages.filledIn, {
                      preset: presetLabel(intl, d.preset),
                    })
                  : intl.formatMessage(messages.sourceSeerr)}
            </span>
            <span>
              {d.banding
                ? intl.formatMessage(messages.bandStep, { step: d.bandStep })
                : intl.formatMessage(messages.noBands)}
            </span>
          </div>
          {!d.applied && (
            <p className="mt-2 text-xs text-yellow-300 light:text-warning-text">
              {intl.formatMessage(messages.notApplied)}
            </p>
          )}

          <Section title={intl.formatMessage(messages.qualities)}>
            <ol className="divide-y divide-gray-700 overflow-hidden rounded-md ring-1 ring-gray-700">
              {d.qualities.map((q) => (
                <li
                  key={q.name}
                  className="flex flex-wrap items-center gap-2 bg-gray-800 px-3 py-2"
                >
                  <span className="flex-1 text-strong">{q.name}</span>
                  {q.goal && (
                    <Badge badgeType="success">
                      {intl.formatMessage(messages.goal)}
                    </Badge>
                  )}
                  {q.lowest && (
                    <Badge badgeType="dark">
                      {intl.formatMessage(messages.lowest)}
                    </Badge>
                  )}
                  {q.maxMbMin !== undefined && q.maxMbMin < 1000 && (
                    <span className="text-xs tabular-nums text-gray-400">
                      {intl.formatMessage(messages.mbMin, { mb: q.maxMbMin })}
                    </span>
                  )}
                </li>
              ))}
            </ol>
            {d.sizeCapGb !== undefined && (
              <p className="mt-1.5 text-xs text-gray-400">
                {intl.formatMessage(messages.filmCap, { gb: d.sizeCapGb })}
              </p>
            )}
            {d.notAllowed.length > 0 && (
              <p className="mt-1.5 text-xs text-gray-400">
                {intl.formatMessage(messages.notAllowed, {
                  list: intl.formatList(d.notAllowed, { type: 'conjunction' }),
                })}
              </p>
            )}
          </Section>

          <Section title={intl.formatMessage(messages.prefers)}>
            <div className="space-y-2">
              {d.bands.map((b, i) => (
                <div
                  key={b.score}
                  className="rounded-md bg-gray-800 px-3 py-2 ring-1 ring-gray-700"
                >
                  <div className="flex items-baseline justify-between">
                    <span className="font-medium text-strong">
                      {intl.formatMessage(
                        i === 0 ? messages.best : messages.better
                      )}
                    </span>
                    <span className="text-xs tabular-nums text-gray-400">
                      {intl.formatNumber(b.score)}
                    </span>
                  </div>
                  <ul className="mt-1 space-y-1">{b.formats.map(formatRow)}</ul>
                </div>
              ))}
              {d.nothing.length > 0 && (
                <div className="rounded-md bg-gray-800 px-3 py-2 ring-1 ring-gray-700">
                  <div className="flex items-baseline justify-between">
                    <span className="font-medium text-strong">
                      {intl.formatMessage(messages.nothing)}
                    </span>
                    <span className="text-xs tabular-nums text-gray-400">
                      0
                    </span>
                  </div>
                  <p className="text-xs text-gray-400">
                    {intl.formatMessage(messages.nothingTip)}
                  </p>
                  <ul className="mt-1 space-y-1">{d.nothing.map(formatRow)}</ul>
                </div>
              )}
              {d.lastResort.length > 0 && (
                <div className="rounded-md bg-gray-800 px-3 py-2 ring-1 ring-gray-700">
                  <div className="font-medium text-strong">
                    {intl.formatMessage(messages.lastResort)}
                  </div>
                  <p className="text-xs text-gray-400">
                    {intl.formatMessage(messages.lastResortTip)}
                  </p>
                  <ul className="mt-1 space-y-1">
                    {d.lastResort.map(formatRow)}
                  </ul>
                </div>
              )}
            </div>
          </Section>

          {d.never.length > 0 && (
            <Section title={intl.formatMessage(messages.never)}>
              <ul className="flex flex-wrap gap-2">
                {d.never.map((f) => (
                  <li
                    key={f.key}
                    className="flex items-center gap-1.5 rounded-full bg-gray-800 py-1 pl-3 pr-1.5 ring-1 ring-red-500/40"
                  >
                    <span className="text-gray-200">{label(f)}</span>
                    <SourceTag origin={f.origin} />
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title={intl.formatMessage(messages.tie)}>
            <ol className="list-inside list-decimal space-y-0.5 text-gray-300">
              <li>{intl.formatMessage(messages.tie1)}</li>
              <li>{intl.formatMessage(messages.tie2)}</li>
              <li>
                {intl.formatMessage(
                  d.preferredProtocol === 'torrent'
                    ? messages.tie3torrent
                    : messages.tie3usenet
                )}
              </li>
              <li>{intl.formatMessage(messages.tie4)}</li>
            </ol>
            {!!d.torrentDelayMinutes && d.preferredProtocol === 'usenet' && (
              <p className="mt-1.5 text-xs text-gray-400">
                {intl.formatMessage(messages.torrentsWait, {
                  minutes: d.torrentDelayMinutes,
                })}
              </p>
            )}
          </Section>

          <Section title={intl.formatMessage(messages.try)}>
            <form className="flex gap-2" onSubmit={tryIt}>
              <input
                type="text"
                className="min-w-0 flex-1"
                value={title}
                placeholder={intl.formatMessage(messages.tryPlaceholder)}
                onChange={(e) => setTitle(e.target.value)}
                aria-label={intl.formatMessage(messages.try)}
              />
              <Button
                type="submit"
                buttonSize="sm"
                className="flex-none"
                disabled={trying || title.trim().length < 3}
              >
                <span>{intl.formatMessage(messages.tryButton)}</span>
              </Button>
            </form>
            {tryError && (
              <p className="mt-2 text-xs text-red-300">{tryError}</p>
            )}
            {tried &&
              (() => {
                const v = verdict(tried);
                return (
                  <div
                    className={`mt-2 rounded-md bg-gray-800 p-3 ring-1 ${
                      v.ok ? 'ring-green-500/40' : 'ring-red-500/40'
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge badgeType={v.ok ? 'success' : 'danger'}>
                        {intl.formatMessage(
                          v.ok ? messages.grab : messages.noGrab
                        )}
                      </Badge>
                      {tried.quality && (
                        <span className="text-gray-300">{tried.quality}</span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-gray-400">{v.text}</p>
                    {tried.matched.length > 0 && (
                      <p className="mt-1 text-xs text-gray-400">
                        {intl.formatMessage(messages.matched, {
                          list: intl.formatList(
                            tried.matched.map(
                              (m) =>
                                `${formatLabel(intl, '', m.name)} (${intl.formatNumber(m.score)})`
                            ),
                            { type: 'conjunction' }
                          ),
                        })}
                      </p>
                    )}
                    {tried.languageUnknown && (
                      <p className="mt-1 text-xs text-gray-400">
                        {intl.formatMessage(messages.languageUnknown)}
                      </p>
                    )}
                  </div>
                );
              })()}
          </Section>

          <Section title={intl.formatMessage(messages.recent)}>
            {!grabs ? (
              <LoadingSpinner />
            ) : !grabs.length ? (
              <p className="text-xs text-gray-400">
                {intl.formatMessage(messages.noGrabs)}
              </p>
            ) : (
              <ul className="space-y-2">
                {grabs.map((g) => (
                  <li
                    key={`${g.title}${g.date}`}
                    className="rounded-md bg-gray-800 p-3 ring-1 ring-gray-700"
                  >
                    <div className="break-all text-xs text-strong">
                      {g.title}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {g.protocol && (
                        <Badge
                          badgeType={
                            g.protocol === 'usenet' ? 'success' : 'dark'
                          }
                        >
                          {intl.formatMessage(
                            g.protocol === 'usenet'
                              ? messages.usenet
                              : messages.torrent
                          )}
                        </Badge>
                      )}
                      <span className="text-xs tabular-nums text-gray-400">
                        {intl.formatMessage(messages.score, {
                          score: intl.formatNumber(g.score),
                        })}{' '}
                        ·{' '}
                        <FormattedRelativeTime
                          value={Math.floor(
                            (new Date(g.date).getTime() - Date.now()) / 1000
                          )}
                          updateIntervalInSeconds={60}
                          numeric="auto"
                        />
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-gray-300">
                      {g.bySeerr
                        ? intl.formatMessage(
                            g.wonTie ? messages.bySeerrTie : messages.bySeerr
                          )
                        : intl.formatMessage(messages.byArr, { app })}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      )}
    </SlideOver>
  );
};

export default WhatItDoes;
