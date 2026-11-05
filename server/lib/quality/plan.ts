import { getRepository } from '@server/datasource';
import QualityManaged from '@server/entity/QualityManaged';
import type {
  ArrCustomFormat,
  ArrQualityProfile,
} from '@server/lib/autofix/arr';
import { BLOCK_FORMAT_NAME, blockScore } from '@server/lib/blockedGroups';
import type {
  ArrDelayProfile,
  ArrProfileItem,
  QualityServerRef,
} from '@server/lib/quality/arr';
import { QualityArr, serverSettingsOf } from '@server/lib/quality/arr';
import type {
  DesiredProfile,
  DesiredState,
  ProfileBody,
  ServerFacts,
} from '@server/lib/quality/build';
import { buildDesired, materialize } from '@server/lib/quality/build';
import { LAST_RESORT, NEVER, foldName } from '@server/lib/quality/presets';
import type { TrashData } from '@server/lib/quality/trash';
import { trashData } from '@server/lib/quality/trash';
import type {
  ArrKind,
  PresetKey,
  QualityServerSettings,
} from '@server/lib/quality/types';
import {
  PRESET_KEYS,
  requestPresetsOf,
  serverDefaults,
} from '@server/lib/quality/types';
import { getSettings } from '@server/lib/settings';
import { createHash } from 'crypto';

/*
 * What applying a server's choices would change (the preview), computed
 * from the server's current state. Nothing here writes to a server; apply
 * and undo live in lib/quality/engine.
 */

export class QualityError extends Error {
  constructor(
    public readonly code:
      | 'not-found'
      | 'not-managed'
      | 'unsupported'
      | 'busy'
      | 'stale'
      | 'undo-newer-first'
      | 'already-undone',
    message: string
  ) {
    super(message);
  }
}

/** A server's choices, or the defaults if none are saved. */
export const configFor = (ref: QualityServerRef): QualityServerSettings => {
  const server = serverSettingsOf(ref);
  const saved = getSettings().quality.servers.find(
    (s) => s.kind === ref.kind && s.serverId === ref.serverId
  );
  const defaults = serverDefaults(ref.kind, ref.serverId, !!server?.is4k);
  return saved
    ? {
        ...defaults,
        ...saved,
        adjustments: { ...defaults.adjustments, ...saved.adjustments },
        nudges: { ...(saved.nudges ?? {}) },
      }
    : defaults;
};

/** Every Radarr and Sonarr server as a ref. */
export const allServers = (): QualityServerRef[] => [
  ...getSettings().radarr.map((s) => ({
    kind: 'radarr' as const,
    serverId: s.id,
  })),
  ...getSettings().sonarr.map((s) => ({
    kind: 'sonarr' as const,
    serverId: s.id,
  })),
];

const hash = (value: unknown) =>
  createHash('sha1').update(JSON.stringify(value)).digest('hex');

/**
 * Hash of the choices that shape the build, stored on apply so a later
 * TRaSH Guides update can be told apart from unapplied choices.
 */
export const choicesOf = (
  config: QualityServerSettings,
  fillGaps: boolean
): string =>
  hash({
    presets: PRESET_KEYS.map((preset) => config.presets[preset] ?? 'off'),
    adjustments: Object.entries(config.adjustments).sort(([a], [b]) =>
      a.localeCompare(b)
    ),
    nudges: Object.entries(config.nudges).sort(([a], [b]) =>
      a.localeCompare(b)
    ),
    bandStep: config.bandStep,
    fillGaps,
    requests: [config.requestPreset ?? '', config.animeRequestPreset ?? ''],
    // Omitted when no preset has its own size, so hashes stored without
    // sizes still match.
    ...(config.sizes && Object.keys(config.sizes).length
      ? {
          sizes: PRESET_KEYS.flatMap((preset) =>
            config.sizes?.[preset] === undefined
              ? []
              : [[preset, config.sizes[preset]]]
          ),
        }
      : {}),
  });

export interface ServerContext {
  ref: QualityServerRef;
  name: string;
  arr: QualityArr;
  version: string;
  facts: ServerFacts;
  profiles: ArrQualityProfile[];
  formats: ArrCustomFormat[];
  delays: ArrDelayProfile[];
}

const majorOf = (version: string) => Number(version.split('.')[0]) || 0;

/** Sonarr before v4 has no custom formats, so it can't be managed. */
export const supported = (kind: ArrKind, version: string) =>
  kind === 'radarr' || majorOf(version) >= 4;

const hasSizes = (items: ArrProfileItem[]): boolean =>
  items.some(
    (item) =>
      (item.quality && item.maxSize !== undefined) || hasSizes(item.items ?? [])
  );

/** A server's current profiles, formats and delay profiles. */
export const loadContext = async (
  ref: QualityServerRef
): Promise<ServerContext> => {
  const server = serverSettingsOf(ref);
  const arr = QualityArr.forServer(ref);
  if (!server || !arr) {
    throw new QualityError('not-found', 'There is no such server.');
  }
  const version = await arr.version();
  if (!supported(ref.kind, version)) {
    throw new QualityError(
      'unsupported',
      'Sonarr v4 or later is needed for custom formats.'
    );
  }
  const [template, profiles, formats, delays] = await Promise.all([
    arr.template(),
    arr.profiles(),
    arr.formats(),
    arr.delayProfiles(),
  ]);
  return {
    ref,
    name: server.name,
    arr,
    version,
    facts: {
      kind: ref.kind,
      template,
      sizesOnProfile: hasSizes((template.items as ArrProfileItem[]) ?? []),
    },
    profiles,
    formats,
    delays,
  };
};

/** Everything a server should have, from its choices and TRaSH Guides. */
export const desiredFor = (
  config: QualityServerSettings,
  facts: ServerFacts,
  trash: TrashData | null,
  fillGaps = getSettings().quality.trash.fillGaps
): DesiredState => buildDesired(config, facts, trash, fillGaps);

/** Format id → name, for reading a profile's scores. */
export const namesOf = (formats: ArrCustomFormat[]): Map<number, string> =>
  new Map(
    formats
      .filter((f) => f.id !== undefined)
      .map((f) => [f.id as number, f.name])
  );

const itemsOf = (profile: Partial<ArrQualityProfile>) =>
  (profile.items as ArrProfileItem[] | undefined) ?? [];

const itemShape = (items: ArrProfileItem[]): unknown[] =>
  items.map((item) =>
    item.quality
      ? [
          item.quality.name,
          item.allowed,
          item.minSize ?? null,
          item.maxSize ?? null,
          item.preferredSize ?? null,
        ]
      : [item.name, item.allowed, itemShape(item.items ?? [])]
  );

const qualityNames = (items: ArrProfileItem[]): Map<number, string> => {
  const out = new Map<number, string>();
  for (const item of items) {
    if (item.quality) out.set(item.quality.id, item.quality.name);
    else {
      if (item.id !== undefined) out.set(item.id, item.name ?? '');
      for (const [id, name] of qualityNames(item.items ?? [])) {
        out.set(id, name);
      }
    }
  }
  return out;
};

/**
 * A profile's qualities and scores by format name, for change detection.
 * Excludes formats scored 0 (every new format lands in every profile at 0)
 * and the blocked release groups format (synced separately).
 */
export const profileFingerprint = (
  profile: Partial<ArrQualityProfile>,
  formatNames: Map<number, string>
) => {
  const cutoffName = qualityNames(itemsOf(profile)).get(
    profile.cutoff as number
  );
  return hash({
    name: profile.name,
    upgradeAllowed: profile.upgradeAllowed,
    cutoff: cutoffName ?? profile.cutoff,
    min: profile.minFormatScore ?? 0,
    cutoffScore: profile.cutoffFormatScore ?? 0,
    minUpgrade: profile.minUpgradeFormatScore ?? 0,
    items: itemShape(itemsOf(profile)),
    scores: (profile.formatItems ?? [])
      .map((item) => [formatNames.get(item.format) ?? item.name, item.score])
      .filter(([name, score]) => score !== 0 && name !== BLOCK_FORMAT_NAME)
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  });
};

const fingerprintOf = (format: ArrCustomFormat, dropFalse: boolean) =>
  hash({
    name: format.name,
    specs: (format.specifications ?? [])
      .map((spec) => ({
        name: spec.name,
        implementation: spec.implementation,
        negate: !!spec.negate,
        required: !!spec.required,
        fields: (spec.fields ?? [])
          .map((field) => [field.name, field.value ?? null])
          .filter(
            ([, value]) =>
              value !== null && value !== '' && !(dropFalse && value === false)
          )
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });

/**
 * A format's rules as a fingerprint. Omitted and false fields are equal:
 * TRaSH Guides omits a language rule's exceptLanguage and Radarr and Sonarr
 * return it false.
 */
export const formatFingerprint = (format: ArrCustomFormat) =>
  fingerprintOf(format, true);

/** Matches a stored fingerprint computed with or without false fields. */
export const formatMatches = (format: ArrCustomFormat, stored: string) =>
  stored === fingerprintOf(format, true) ||
  stored === fingerprintOf(format, false);

/**
 * The default (untagged) delay profile: the only one Seerr AI changes.
 * Radarr and Sonarr always have it.
 */
export const defaultDelay = (delays: ArrDelayProfile[]) =>
  delays.find((d) => !d.tags?.length);

// Change details for the preview and History. Structured rather than worded
// so the page can translate them.
export type ChangeDetail =
  | { kind: 'score'; format: string; from: number; to: number }
  | { kind: 'cutoff'; from: string; to: string }
  | { kind: 'qualities' }
  | { kind: 'sizes' }
  | { kind: 'min-score'; from: number; to: number }
  | { kind: 'rules' }
  | { kind: 'protocol'; from: string; to: string }
  | { kind: 'torrent-delay'; from: number; to: number }
  | {
      kind: 'requests';
      which: 'main' | 'anime';
      preset: PresetKey;
      from?: string;
      to: string;
    };

/** What a format does to a matching release in one profile. */
export type FormatEffect =
  | 'never'
  | 'last-resort'
  | 'lower'
  | 'prefer'
  | 'none';

export interface PreviewChange {
  itemKind: 'profile' | 'format' | 'delay' | 'requests';
  key: string;
  name: string;
  action: 'create' | 'update' | 'put-back' | 'unchanged' | 'kept';
  details: ChangeDetail[];
  /** A format's effect in each profile that uses it, by preset. */
  effects?: { preset: PresetKey; effect: FormatEffect }[];
}

export const effectOf = (score: number): FormatEffect =>
  score <= NEVER
    ? 'never'
    : score <= LAST_RESORT
      ? 'last-resort'
      : score < 0
        ? 'lower'
        : score > 0
          ? 'prefer'
          : 'none';

export interface Preview {
  kind: ArrKind;
  serverId: number;
  serverName: string;
  /** Nothing has been applied to this server yet. */
  first: boolean;
  changes: PreviewChange[];
  /** The admin's own profiles, left untouched. */
  ownProfiles: { id: number; name: string; titles: number }[];
  skipped: DesiredState['skipped'];
  sizesOnProfile: boolean;
  /**
   * Hash of what this preview would change; an apply with a stale token
   * changes nothing.
   */
  token: string;
}

export interface Plan {
  ctx: ServerContext;
  config: QualityServerSettings;
  /** The TRaSH Guides copy this was computed from. */
  trash: TrashData | null;
  fillGaps: boolean;
  desired: DesiredState;
  rows: QualityManaged[];
  /** Server format id by desired format key, for formats the server has. */
  formatIds: Map<string, number>;
  preview: Preview;
}

export const rowsFor = (ref: QualityServerRef) =>
  getRepository(QualityManaged).find({
    where: { serverKind: ref.kind, serverId: ref.serverId },
  });

const allowedNames = (items: ArrProfileItem[]): string[] =>
  items.flatMap((item) =>
    item.quality
      ? item.allowed
        ? [item.quality.name]
        : []
      : item.allowed
        ? [item.name ?? '', ...allowedNames(item.items ?? [])]
        : allowedNames(item.items ?? [])
  );

const sizeShape = (items: ArrProfileItem[]): unknown[] =>
  items.flatMap((item) =>
    item.quality
      ? [[item.quality.name, item.minSize, item.maxSize, item.preferredSize]]
      : sizeShape(item.items ?? [])
  );

/** How one profile differs from what it should be. */
const profileDetails = (
  current: ArrQualityProfile,
  next: ProfileBody,
  formatNames: Map<number, string>
): ChangeDetail[] => {
  const details: ChangeDetail[] = [];
  const from = qualityNames(itemsOf(current)).get(current.cutoff as number);
  const to = qualityNames(next.items).get(next.cutoff);
  if ((from ?? '') !== (to ?? '')) {
    details.push({ kind: 'cutoff', from: from ?? '', to: to ?? '' });
  }
  if (
    allowedNames(itemsOf(current)).join('|') !==
    allowedNames(next.items).join('|')
  ) {
    details.push({ kind: 'qualities' });
  }
  if (
    JSON.stringify(sizeShape(itemsOf(current))) !==
    JSON.stringify(sizeShape(next.items))
  ) {
    details.push({ kind: 'sizes' });
  }
  if ((current.minFormatScore ?? 0) !== next.minFormatScore) {
    details.push({
      kind: 'min-score',
      from: current.minFormatScore ?? 0,
      to: next.minFormatScore,
    });
  }
  const scoreOf = (items: ArrQualityProfile['formatItems']) =>
    new Map(
      (items ?? []).map((item) => [
        formatNames.get(item.format) ?? item.name ?? '',
        item.score,
      ])
    );
  const before = scoreOf(current.formatItems);
  const after = scoreOf(next.formatItems);
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    if (name === BLOCK_FORMAT_NAME) continue;
    const x = before.get(name) ?? 0;
    const y = after.get(name) ?? 0;
    if (x !== y) details.push({ kind: 'score', format: name, from: x, to: y });
  }
  return details;
};

/** Scores the blocked release groups format as it is everywhere else. */
export const withBlockScore = <T extends Partial<ArrQualityProfile>>(
  profile: T,
  formats: ArrCustomFormat[]
): T => {
  const block = formats.find((f) => f.name === BLOCK_FORMAT_NAME);
  if (!block?.id) return profile;
  const score = blockScore(
    {
      minFormatScore: profile.minFormatScore,
      formatItems: profile.formatItems ?? [],
    },
    block.id
  );
  return {
    ...profile,
    formatItems: (profile.formatItems ?? []).map((item) =>
      item.format === block.id ? { ...item, score } : item
    ),
  };
};

/** Placeholder ids for formats not yet on the server, for the preview. */
const withPlaceholders = (
  ctx: ServerContext,
  desired: DesiredState,
  ids: Map<string, number>
): ArrCustomFormat[] => {
  const formats = [...ctx.formats];
  let next = -1;
  for (const def of desired.formats) {
    if (!ids.has(def.key)) {
      ids.set(def.key, next);
      formats.push({ ...def.format, id: next });
      next -= 1;
    }
  }
  return formats;
};

/**
 * Maps each desired format to a server format: the one Seerr AI created for
 * it, else a same-named one no other Seerr AI format owns. No two desired
 * formats share one.
 */
export const matchFormats = (
  formats: ArrCustomFormat[],
  desired: DesiredState,
  rows: QualityManaged[]
): Map<string, number> => {
  const ids = new Map<string, number>();
  const owned = new Set(
    rows.filter((r) => r.itemKind === 'format').map((r) => r.arrId)
  );
  const exists = new Set(namesOf(formats).keys());
  for (const def of desired.formats) {
    const row = rows.find((r) => r.itemKind === 'format' && r.key === def.key);
    if (row && exists.has(row.arrId)) ids.set(def.key, row.arrId);
  }
  const taken = new Set(ids.values());
  for (const def of desired.formats) {
    if (ids.has(def.key)) continue;
    const name = foldName(def.format.name);
    const same = formats.find(
      (f) =>
        f.id !== undefined &&
        foldName(f.name) === name &&
        !owned.has(f.id) &&
        !taken.has(f.id)
    );
    if (same?.id !== undefined) {
      ids.set(def.key, same.id);
      taken.add(same.id);
    }
  }
  return ids;
};

/**
 * Radarr and Sonarr allow each format name once, in any case. A desired
 * format whose name is taken on the server (say, by one Seerr AI no longer
 * uses) or by another desired format gets a number suffix so the apply
 * doesn't fail.
 */
export const unclash = (
  formats: ArrCustomFormat[],
  desired: DesiredState,
  ids: Map<string, number>
): DesiredState => {
  const onServer = new Map<string, number[]>();
  for (const f of formats) {
    if (f.id === undefined) continue;
    const name = foldName(f.name);
    onServer.set(name, [...(onServer.get(name) ?? []), f.id]);
  }
  const given = new Set<string>();
  const out = desired.formats.map((def) => {
    const own = ids.get(def.key);
    const free = (name: string) =>
      !given.has(foldName(name)) &&
      (onServer.get(foldName(name)) ?? []).every((id) => id === own);
    let name = def.format.name;
    for (let n = 2; !free(name); n += 1) name = `${def.format.name} (${n})`;
    given.add(foldName(name));
    return name === def.format.name
      ? def
      : { ...def, format: { ...def.format, name } };
  });
  return { ...desired, formats: out };
};

/** A preset's server profile: the one Seerr AI created, else one by name. */
export const matchProfile = (
  ctx: ServerContext,
  desired: DesiredProfile,
  rows: QualityManaged[]
) => {
  const row = rows.find(
    (r) => r.itemKind === 'profile' && r.key === desired.preset
  );
  return {
    row,
    current:
      (row && ctx.profiles.find((p) => p.id === row.arrId)) ??
      ctx.profiles.find((p) => p.name === desired.name),
  };
};

/**
 * Hash of a preview's changes plus the desired state (a create's details
 * don't say what it writes), to check the preview still holds.
 */
const tokenOf = (changes: PreviewChange[], desired: DesiredState) =>
  hash({
    changes: changes
      .filter((c) => c.action !== 'unchanged')
      .map((c) => [c.itemKind, c.key, c.action, c.details]),
    desired,
  });

/** What applying a server's choices would change, and what it would use. */
export const planFor = async (
  ref: QualityServerRef,
  options: { restoreKept?: boolean } = {}
): Promise<Plan> => {
  const config = configFor(ref);
  if (!config.managed) {
    throw new QualityError(
      'not-managed',
      'Seerr AI does not manage this server.'
    );
  }
  const fillGaps = getSettings().quality.trash.fillGaps;
  const [ctx, rows, trash] = await Promise.all([
    loadContext(ref),
    rowsFor(ref),
    trashData(),
  ]);
  const built = desiredFor(config, ctx.facts, trash, fillGaps);
  const formatIds = matchFormats(ctx.formats, built, rows);
  const desired = unclash(ctx.formats, built, formatIds);
  const changes: PreviewChange[] = [];
  const change = (
    itemKind: PreviewChange['itemKind'],
    key: string,
    name: string,
    action: PreviewChange['action'],
    details: ChangeDetail[] = []
  ) => changes.push({ itemKind, key, name, action, details });

  // Each format's effect per profile, so the preview can say which avoid a
  // release and which favor it.
  const effects = new Map<string, NonNullable<PreviewChange['effects']>>();
  for (const profile of desired.profiles) {
    for (const scored of profile.formats) {
      const list = effects.get(scored.key) ?? [];
      list.push({ preset: profile.preset, effect: effectOf(scored.score) });
      effects.set(scored.key, list);
    }
  }

  for (const def of desired.formats) {
    const row = rows.find((r) => r.itemKind === 'format' && r.key === def.key);
    const id = formatIds.get(def.key);
    const current = ctx.formats.find((f) => f.id === id);
    const name = def.format.name;
    if (!current) {
      change('format', def.key, name, row ? 'put-back' : 'create');
    } else if (row?.keptAsEdited && !options.restoreKept) {
      change('format', def.key, name, 'kept');
    } else if (formatFingerprint(current) !== formatFingerprint(def.format)) {
      const drifted = !!row && !formatMatches(current, row.fingerprint);
      change('format', def.key, name, drifted ? 'put-back' : 'update', [
        { kind: 'rules' },
      ]);
    } else {
      change('format', def.key, name, 'unchanged');
    }
  }

  for (const c of changes) {
    if (c.itemKind === 'format') c.effects = effects.get(c.key) ?? [];
  }

  const placeholderIds = new Map(formatIds);
  const formats = withPlaceholders(ctx, desired, placeholderIds);
  const names = namesOf(formats);
  const profileIds = new Map<PresetKey, number>();
  for (const profile of desired.profiles) {
    const { row, current } = matchProfile(ctx, profile, rows);
    if (current) profileIds.set(profile.preset, current.id);
    if (!current) {
      change(
        'profile',
        profile.preset,
        profile.name,
        row ? 'put-back' : 'create'
      );
      continue;
    }
    if (row?.keptAsEdited && !options.restoreKept) {
      change('profile', profile.preset, profile.name, 'kept');
      continue;
    }
    const next = withBlockScore(
      materialize(profile, ctx.facts, placeholderIds, formats, new Map()),
      formats
    );
    const details = profileDetails(current, next, names);
    // Changed in the app in a way the details don't cover (e.g. its name):
    // still restored.
    const drifted =
      !!row && profileFingerprint(current, names) !== row.fingerprint;
    change(
      'profile',
      profile.preset,
      profile.name,
      drifted ? 'put-back' : details.length ? 'update' : 'unchanged',
      details
    );
  }

  const delay = defaultDelay(ctx.delays);
  if (desired.delay && delay) {
    const details: ChangeDetail[] = [];
    if (delay.preferredProtocol !== desired.delay.preferredProtocol) {
      details.push({
        kind: 'protocol',
        from: delay.preferredProtocol,
        to: desired.delay.preferredProtocol,
      });
    }
    if (
      desired.delay.torrentDelay !== null &&
      delay.torrentDelay !== desired.delay.torrentDelay
    ) {
      details.push({
        kind: 'torrent-delay',
        from: delay.torrentDelay,
        to: desired.delay.torrentDelay,
      });
    }
    change(
      'delay',
      'delay',
      'Delay profile',
      details.length ? 'update' : 'unchanged',
      details
    );
  }

  // Point new requests to this server (its Services settings) at the
  // presets' profiles, unless left as is.
  const server = serverSettingsOf(ref);
  if (server) {
    const wanted = requestPresetsOf(config, server.is4k);
    const details: ChangeDetail[] = [];
    const point = (
      which: 'main' | 'anime',
      preset: PresetKey | undefined,
      currentId: number | undefined,
      currentName: string | undefined
    ) => {
      const to =
        preset && desired.profiles.find((p) => p.preset === preset)?.name;
      if (!preset || !to) return;
      if (currentId !== undefined && profileIds.get(preset) === currentId) {
        return;
      }
      details.push({ kind: 'requests', which, preset, from: currentName, to });
    };
    point(
      'main',
      wanted.main,
      server.activeProfileId,
      server.activeProfileName
    );
    point(
      'anime',
      wanted.anime,
      server.activeAnimeProfileId,
      server.activeAnimeProfileName
    );
    if (details.length) {
      change('requests', 'requests', 'Request defaults', 'update', details);
    }
  }

  const own = new Set(
    rows.filter((r) => r.itemKind === 'profile').map((r) => r.arrId)
  );
  const ownProfiles = ctx.profiles
    .filter(
      (p) => !own.has(p.id) && !desired.profiles.some((d) => d.name === p.name)
    )
    .map((p) => ({ id: p.id, name: p.name, titles: 0 }));

  return {
    ctx,
    config,
    trash,
    fillGaps,
    desired,
    rows,
    formatIds,
    preview: {
      kind: ref.kind,
      serverId: ref.serverId,
      serverName: ctx.name,
      first: !rows.length,
      changes,
      ownProfiles,
      skipped: desired.skipped,
      sizesOnProfile: ctx.facts.sizesOnProfile,
      token: tokenOf(changes, desired),
    },
  };
};
