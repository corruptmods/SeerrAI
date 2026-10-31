import { getRepository } from '@server/datasource';
import type {
  QualityBefore,
  QualityMovedTitle,
} from '@server/entity/QualityApply';
import QualityApply from '@server/entity/QualityApply';
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
  DesiredDelay,
  DesiredProfile,
  DesiredState,
  ProfileBody,
  ServerFacts,
} from '@server/lib/quality/build';
import { buildDesired, materialize } from '@server/lib/quality/build';
import { trashData } from '@server/lib/quality/trash';
import type {
  ArrKind,
  PresetKey,
  QualityServerSettings,
} from '@server/lib/quality/types';
import { serverDefaults } from '@server/lib/quality/types';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { createHash } from 'crypto';
import { IsNull } from 'typeorm';

/*
 * Settings → Quality's work on a server: what applying would change
 * (the preview), applying it, undoing an apply, and noticing when someone
 * changed one of Seerr AI's profiles in Radarr or Sonarr itself. Only what
 * Seerr AI created is ever written; nothing happens to a server an admin
 * hasn't chosen to manage.
 */

const LABEL = 'Quality';

export class QualityError extends Error {
  constructor(
    public readonly code:
      | 'not-found'
      | 'not-managed'
      | 'unsupported'
      | 'busy'
      | 'undo-newer-first'
      | 'already-undone',
    message: string
  ) {
    super(message);
  }
}

/** A server's choices, or the defaults before an admin made any. */
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

/** Sonarr before v4 has no custom formats, so nothing can be set up. */
export const supported = (kind: ArrKind, version: string) =>
  kind === 'radarr' || majorOf(version) >= 4;

const hasSizes = (items: ArrProfileItem[]): boolean =>
  items.some(
    (item) =>
      (item.quality && item.maxSize !== undefined) || hasSizes(item.items ?? [])
  );

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

const hash = (value: unknown) =>
  createHash('sha1').update(JSON.stringify(value)).digest('hex');

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
 * What a profile is, for telling whether it changed: its qualities and
 * scores by format name. Formats scored 0 (every new format lands in every
 * profile at 0) and the blocked release groups format (kept in step on its
 * own) are left out.
 */
export const profileFingerprint = (
  profile: Partial<ArrQualityProfile>,
  formatNames: Map<number, string>
) => {
  const cutoffName = qualityNames(
    (profile.items as ArrProfileItem[]) ?? []
  ).get(profile.cutoff as number);
  return hash({
    name: profile.name,
    upgradeAllowed: profile.upgradeAllowed,
    cutoff: cutoffName ?? profile.cutoff,
    min: profile.minFormatScore ?? 0,
    cutoffScore: profile.cutoffFormatScore ?? 0,
    minUpgrade: profile.minUpgradeFormatScore ?? 0,
    items: itemShape((profile.items as ArrProfileItem[]) ?? []),
    scores: (profile.formatItems ?? [])
      .map((item) => [formatNames.get(item.format) ?? item.name, item.score])
      .filter(([name, score]) => score !== 0 && name !== BLOCK_FORMAT_NAME)
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  });
};

export const formatFingerprint = (format: ArrCustomFormat) =>
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
          .filter(([, value]) => value !== null && value !== '')
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });

/** The delay profile every title without its own tags uses. */
const defaultDelay = (delays: ArrDelayProfile[]) =>
  delays.find((d) => !d.tags?.length) ??
  [...delays].sort((a, b) => b.order - a.order)[0];

// What changed, for the preview and History. Words are the page's own;
// these say what, so they can be put in any language.
export type ChangeDetail =
  | { kind: 'score'; format: string; from: number; to: number }
  | { kind: 'cutoff'; from: string; to: string }
  | { kind: 'qualities' }
  | { kind: 'sizes' }
  | { kind: 'min-score'; from: number; to: number }
  | { kind: 'rules' }
  | { kind: 'protocol'; from: string; to: string }
  | { kind: 'torrent-delay'; from: number; to: number };

export interface PreviewChange {
  itemKind: 'profile' | 'format' | 'delay';
  key: string;
  name: string;
  action: 'create' | 'update' | 'put-back' | 'unchanged' | 'kept';
  details: ChangeDetail[];
}

export interface Preview {
  kind: ArrKind;
  serverId: number;
  serverName: string;
  /** Nothing has been applied to this server yet. */
  first: boolean;
  changes: PreviewChange[];
  /** The admin's own profiles: left as they are. */
  ownProfiles: { id: number; name: string; titles: number }[];
  skipped: DesiredState['skipped'];
  sizesOnProfile: boolean;
}

interface Plan {
  ctx: ServerContext;
  config: QualityServerSettings;
  desired: DesiredState;
  rows: QualityManaged[];
  preview: Preview;
}

const rowsFor = (ref: QualityServerRef) =>
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

const sizeShape = (items: ArrProfileItem[]): string =>
  JSON.stringify(
    items.flatMap((item) =>
      item.quality
        ? [[item.quality.name, item.minSize, item.maxSize, item.preferredSize]]
        : JSON.parse(sizeShape(item.items ?? []))
    )
  );

/** How one profile differs from what it should be. */
const profileDetails = (
  current: ArrQualityProfile,
  next: ProfileBody,
  formatNames: Map<number, string>
): ChangeDetail[] => {
  const details: ChangeDetail[] = [];
  const currentNames = qualityNames((current.items as ArrProfileItem[]) ?? []);
  const nextNames = qualityNames((next.items as ArrProfileItem[]) ?? []);
  const from = currentNames.get(current.cutoff as number) ?? '';
  const to = nextNames.get(next.cutoff as number) ?? '';
  if (from !== to) details.push({ kind: 'cutoff', from, to });
  const a = allowedNames((current.items as ArrProfileItem[]) ?? []);
  const b = allowedNames((next.items as ArrProfileItem[]) ?? []);
  if (a.join('|') !== b.join('|')) details.push({ kind: 'qualities' });
  if (
    sizeShape((current.items as ArrProfileItem[]) ?? []) !==
    sizeShape((next.items as ArrProfileItem[]) ?? [])
  ) {
    details.push({ kind: 'sizes' });
  }
  if ((current.minFormatScore ?? 0) !== (next.minFormatScore ?? 0)) {
    details.push({
      kind: 'min-score',
      from: current.minFormatScore ?? 0,
      to: next.minFormatScore ?? 0,
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

/** The blocked release groups format scored as it is everywhere else. */
const withBlockScore = <T extends Partial<ArrQualityProfile>>(
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

/** Placeholder ids for formats not yet in the server, for the preview. */
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

/** Which server format each desired format is: its own, or one of that name. */
const matchFormats = (
  ctx: ServerContext,
  desired: DesiredState,
  rows: QualityManaged[]
): Map<string, number> => {
  const ids = new Map<string, number>();
  for (const def of desired.formats) {
    const row = rows.find((r) => r.itemKind === 'format' && r.key === def.key);
    const own = row && ctx.formats.find((f) => f.id === row.arrId);
    const same = ctx.formats.find((f) => f.name === def.format.name);
    const id = own?.id ?? same?.id;
    if (id !== undefined) ids.set(def.key, id);
  }
  return ids;
};

const matchProfile = (
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

const planFor = async (
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
  const [ctx, rows, trash] = await Promise.all([
    loadContext(ref),
    rowsFor(ref),
    trashData(),
  ]);
  const desired = buildDesired(
    config,
    ctx.facts,
    trash,
    getSettings().quality.trash.fillGaps
  );
  const changes: PreviewChange[] = [];
  const ids = matchFormats(ctx, desired, rows);

  for (const def of desired.formats) {
    const row = rows.find((r) => r.itemKind === 'format' && r.key === def.key);
    const id = ids.get(def.key);
    const current = ctx.formats.find((f) => f.id === id);
    if (!current) {
      changes.push({
        itemKind: 'format',
        key: def.key,
        name: def.format.name,
        action: row ? 'put-back' : 'create',
        details: [],
      });
    } else if (row?.keptAsEdited && !options.restoreKept) {
      changes.push({
        itemKind: 'format',
        key: def.key,
        name: def.format.name,
        action: 'kept',
        details: [],
      });
    } else if (formatFingerprint(current) !== formatFingerprint(def.format)) {
      changes.push({
        itemKind: 'format',
        key: def.key,
        name: def.format.name,
        action:
          row && formatFingerprint(current) !== row.fingerprint
            ? 'put-back'
            : 'update',
        details: [{ kind: 'rules' }],
      });
    } else {
      changes.push({
        itemKind: 'format',
        key: def.key,
        name: def.format.name,
        action: 'unchanged',
        details: [],
      });
    }
  }

  const formats = withPlaceholders(ctx, desired, ids);
  const names = new Map(
    formats
      .filter((f) => f.id !== undefined)
      .map((f) => [f.id as number, f.name])
  );
  for (const profile of desired.profiles) {
    const { row, current } = matchProfile(ctx, profile, rows);
    const next = withBlockScore(
      materialize(profile, ctx.facts, ids, formats, new Map()),
      formats
    );
    if (!current) {
      changes.push({
        itemKind: 'profile',
        key: profile.preset,
        name: profile.name,
        action: row ? 'put-back' : 'create',
        details: [],
      });
      continue;
    }
    if (row?.keptAsEdited && !options.restoreKept) {
      changes.push({
        itemKind: 'profile',
        key: profile.preset,
        name: profile.name,
        action: 'kept',
        details: [],
      });
      continue;
    }
    const details = profileDetails(current, next, names);
    const drifted =
      !!row && profileFingerprint(current, names) !== row.fingerprint;
    changes.push({
      itemKind: 'profile',
      key: profile.preset,
      name: profile.name,
      action: details.length ? (drifted ? 'put-back' : 'update') : 'unchanged',
      details,
    });
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
    changes.push({
      itemKind: 'delay',
      key: 'delay',
      name: 'Delay profile',
      action: details.length ? 'update' : 'unchanged',
      details,
    });
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
    desired,
    rows,
    preview: {
      kind: ref.kind,
      serverId: ref.serverId,
      serverName: ctx.name,
      first: !rows.length,
      changes,
      ownProfiles,
      skipped: desired.skipped,
      sizesOnProfile: ctx.facts.sizesOnProfile,
    },
  };
};

/** What applying would change, without changing anything. */
export const preview = async (ref: QualityServerRef): Promise<Preview> => {
  const plan = await planFor(ref, { restoreKept: true });
  const titles = await plan.ctx.arr.titles().catch(() => []);
  for (const profile of plan.preview.ownProfiles) {
    profile.titles = titles.filter((t) => t.profileId === profile.id).length;
  }
  return plan.preview;
};

const busy = new Set<string>();
const lockKey = (ref: QualityServerRef) => `${ref.kind}:${ref.serverId}`;

const withLock = async <T>(
  ref: QualityServerRef,
  work: () => Promise<T>
): Promise<T> => {
  const key = lockKey(ref);
  if (busy.has(key)) {
    throw new QualityError(
      'busy',
      'Something is already being applied to this server.'
    );
  }
  busy.add(key);
  try {
    return await work();
  } finally {
    busy.delete(key);
  }
};

const saveRow = async (
  ref: QualityServerRef,
  itemKind: 'profile' | 'format',
  key: string,
  arrId: number,
  fingerprint: string
) => {
  const repo = getRepository(QualityManaged);
  const row = await repo.findOne({
    where: { serverKind: ref.kind, serverId: ref.serverId, itemKind, key },
  });
  if (row) {
    row.arrId = arrId;
    row.fingerprint = fingerprint;
    row.keptAsEdited = false;
    await repo.save(row);
  } else {
    await repo.save(
      new QualityManaged({
        serverKind: ref.kind,
        serverId: ref.serverId,
        itemKind,
        key,
        arrId,
        fingerprint,
        keptAsEdited: false,
      })
    );
  }
};

export interface ApplyOptions {
  /** Titles on one of the admin's own profiles to move onto a preset's. */
  move?: { fromProfileId: number; preset: PresetKey }[];
  /** Puts back profiles and formats someone chose to keep as edited. */
  restoreKept?: boolean;
  /** A TRaSH Guides update applied on its own. */
  trash?: boolean;
  userId?: number | null;
}

export interface ApplyResult {
  applyId: number | null;
  created: number;
  updated: number;
  moved: number;
}

/** Applies a server's choices: the preview, made so. */
export const apply = async (
  ref: QualityServerRef,
  options: ApplyOptions = {}
): Promise<ApplyResult> =>
  withLock(ref, async () => {
    const plan = await planFor(ref, { restoreKept: options.restoreKept });
    const { ctx, desired, rows } = plan;
    const befores: QualityBefore[] = [];
    let created = 0;
    let updated = 0;

    // Formats first: the profiles score them by their ids.
    const ids = matchFormats(ctx, desired, rows);
    for (const def of desired.formats) {
      const change = plan.preview.changes.find(
        (c) => c.itemKind === 'format' && c.key === def.key
      );
      const id = ids.get(def.key);
      const current = ctx.formats.find((f) => f.id === id);
      if (change?.action === 'kept') continue;
      if (!current) {
        const saved = await ctx.arr.saveFormat(def.format);
        if (saved.id === undefined) continue;
        ids.set(def.key, saved.id);
        befores.push({
          itemKind: 'format',
          key: def.key,
          arrId: saved.id,
          before: null,
        });
        created += 1;
        await saveRow(
          ref,
          'format',
          def.key,
          saved.id,
          formatFingerprint(saved)
        );
      } else if (change?.action === 'update' || change?.action === 'put-back') {
        const saved = await ctx.arr.saveFormat({
          ...def.format,
          id: current.id,
        });
        befores.push({
          itemKind: 'format',
          key: def.key,
          arrId: current.id as number,
          before: current as unknown as Record<string, unknown>,
        });
        updated += 1;
        await saveRow(
          ref,
          'format',
          def.key,
          current.id as number,
          formatFingerprint(saved)
        );
      } else {
        await saveRow(
          ref,
          'format',
          def.key,
          current.id as number,
          formatFingerprint(current)
        );
      }
    }

    const formats = await ctx.arr.formats();
    const names = new Map(
      formats
        .filter((f) => f.id !== undefined)
        .map((f) => [f.id as number, f.name])
    );
    const profileIds = new Map<PresetKey, number>();
    for (const profile of desired.profiles) {
      const change = plan.preview.changes.find(
        (c) => c.itemKind === 'profile' && c.key === profile.preset
      );
      const { current } = matchProfile(ctx, profile, rows);
      if (current) profileIds.set(profile.preset, current.id);
      if (change?.action === 'kept') continue;
      const next = withBlockScore(
        materialize(profile, ctx.facts, ids, formats, new Map()),
        formats
      );
      if (!current) {
        const saved = await ctx.arr.createProfile(next);
        profileIds.set(profile.preset, saved.id);
        befores.push({
          itemKind: 'profile',
          key: profile.preset,
          arrId: saved.id,
          before: null,
        });
        created += 1;
        await saveRow(
          ref,
          'profile',
          profile.preset,
          saved.id,
          profileFingerprint(saved, names)
        );
      } else if (change?.action === 'update' || change?.action === 'put-back') {
        const saved = await ctx.arr.saveProfile({ ...next, id: current.id });
        befores.push({
          itemKind: 'profile',
          key: profile.preset,
          arrId: current.id,
          before: current as unknown as Record<string, unknown>,
        });
        updated += 1;
        await saveRow(
          ref,
          'profile',
          profile.preset,
          current.id,
          profileFingerprint({ ...next, ...saved, id: current.id }, names)
        );
      } else {
        await saveRow(
          ref,
          'profile',
          profile.preset,
          current.id,
          profileFingerprint(current, names)
        );
      }
    }

    const delay = defaultDelay(ctx.delays);
    const delayChange = plan.preview.changes.find(
      (c) => c.itemKind === 'delay'
    );
    if (desired.delay && delay && delayChange?.action === 'update') {
      befores.push({
        itemKind: 'delay',
        key: 'delay',
        arrId: delay.id,
        before: delay as unknown as Record<string, unknown>,
      });
      await ctx.arr.saveDelayProfile(delayWith(delay, desired.delay));
      updated += 1;
    }

    const moved: QualityMovedTitle[] = [];
    if (options.move?.length) {
      const titles = await ctx.arr.titles();
      for (const move of options.move) {
        const to = profileIds.get(move.preset);
        if (to === undefined || move.fromProfileId === to) continue;
        // Only the admin's own profiles, never one Seerr AI manages.
        if ([...profileIds.values()].includes(move.fromProfileId)) continue;
        const ids = titles
          .filter((t) => t.profileId === move.fromProfileId)
          .map((t) => t.id);
        await ctx.arr.moveTitles(ids, to);
        moved.push(
          ...ids.map((arrId) => ({ arrId, fromProfileId: move.fromProfileId }))
        );
      }
    }

    const trash = await trashData();
    const settings = getSettings();
    const quality = settings.quality;
    const usesTrash = Object.values(plan.config.presets).includes('trash');
    quality.servers = [
      ...quality.servers.filter(
        (s) => !(s.kind === ref.kind && s.serverId === ref.serverId)
      ),
      {
        ...plan.config,
        trashCommit: usesTrash ? trash?.commit : undefined,
        trashRaw: trashRawOf(desired, plan.config),
      },
    ];
    settings.quality = quality;
    await settings.save();

    let applyId: number | null = null;
    if (befores.length || moved.length) {
      const entry = await getRepository(QualityApply).save(
        new QualityApply({
          serverKind: ref.kind,
          serverId: ref.serverId,
          userId: options.userId ?? null,
          summary: {
            created,
            updated,
            ...(options.trash ? { trash: true } : {}),
          },
          befores,
          moved,
          undoneAt: null,
        })
      );
      applyId = entry.id;
    }
    logger.info('Quality profiles applied', {
      label: LABEL,
      server: ctx.name,
      created,
      updated,
      moved: moved.length,
    });
    return { applyId, created, updated, moved: moved.length };
  });

/** TRaSH Guides' own score of each TRaSH format an admin moved. */
const trashRawOf = (
  desired: DesiredState,
  config: QualityServerSettings
): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const profile of desired.profiles) {
    for (const format of profile.formats) {
      if (format.raw !== undefined && config.nudges[format.key]) {
        out[format.key] = format.raw;
      }
    }
  }
  return out;
};

const delayWith = (
  delay: ArrDelayProfile,
  wanted: DesiredDelay
): ArrDelayProfile => ({
  ...delay,
  preferredProtocol: wanted.preferredProtocol,
  ...(wanted.torrentDelay !== null
    ? { torrentDelay: wanted.torrentDelay }
    : {}),
});

/** Profile ids Seerr AI's request settings send titles to. */
const inUseBySettings = (ref: QualityServerRef): Set<number> => {
  const server = serverSettingsOf(ref);
  const ids = new Set<number>();
  if (server) {
    ids.add(server.activeProfileId);
    if (server.activeAnimeProfileId !== undefined) {
      ids.add(server.activeAnimeProfileId);
    }
  }
  return ids;
};

export interface UndoResult {
  restored: number;
  removed: number;
  /** Profiles kept because titles or Seerr AI's request settings use them. */
  keptInUse: string[];
  movedBack: number;
}

/** Puts back what one apply changed. Only the newest one, each server. */
export const undo = async (applyId: number): Promise<UndoResult> => {
  const repo = getRepository(QualityApply);
  const entry = await repo.findOne({ where: { id: applyId } });
  if (!entry) throw new QualityError('not-found', 'There is no such apply.');
  if (entry.undoneAt) {
    throw new QualityError('already-undone', 'It was already undone.');
  }
  const ref = { kind: entry.serverKind, serverId: entry.serverId };
  const newer = await repo.findOne({
    where: {
      serverKind: entry.serverKind,
      serverId: entry.serverId,
      undoneAt: IsNull(),
    },
    order: { id: 'DESC' },
  });
  if (newer && newer.id !== entry.id) {
    throw new QualityError(
      'undo-newer-first',
      'A newer change to this server has to be undone first.'
    );
  }
  return withLock(ref, async () => {
    const arr = QualityArr.forServer(ref);
    if (!arr) throw new QualityError('not-found', 'There is no such server.');
    const rows = getRepository(QualityManaged);
    const result: UndoResult = {
      restored: 0,
      removed: 0,
      keptInUse: [],
      movedBack: 0,
    };

    // Titles first, so a profile they were moved onto is free to go.
    const byFrom = new Map<number, number[]>();
    for (const move of entry.moved) {
      byFrom.set(move.fromProfileId, [
        ...(byFrom.get(move.fromProfileId) ?? []),
        move.arrId,
      ]);
    }
    for (const [profileId, ids] of byFrom) {
      await arr.moveTitles(ids, profileId);
      result.movedBack += ids.length;
    }

    const formats = await arr.formats();
    const names = new Map(
      formats
        .filter((f) => f.id !== undefined)
        .map((f) => [f.id as number, f.name])
    );
    const needed = inUseBySettings(ref);
    let titles: { profileId: number }[] | undefined;
    // Profiles before formats, newest change first.
    const order = [...entry.befores].sort(
      (a, b) =>
        (a.itemKind === 'profile' ? 0 : a.itemKind === 'delay' ? 1 : 2) -
        (b.itemKind === 'profile' ? 0 : b.itemKind === 'delay' ? 1 : 2)
    );
    for (const item of order) {
      const where = {
        serverKind: ref.kind,
        serverId: ref.serverId,
        itemKind: item.itemKind as 'profile' | 'format',
        key: item.key,
      };
      if (item.before === null) {
        if (item.itemKind === 'profile') {
          titles ??= await arr.titles();
          const used =
            needed.has(item.arrId) ||
            titles.some((t) => t.profileId === item.arrId);
          if (used) {
            const profile = (await arr.profiles()).find(
              (p) => p.id === item.arrId
            );
            result.keptInUse.push(profile?.name ?? String(item.arrId));
          } else {
            await arr.deleteProfile(item.arrId).catch(() => undefined);
            result.removed += 1;
          }
        } else if (item.itemKind === 'format') {
          await arr.deleteFormat(item.arrId).catch(() => undefined);
          result.removed += 1;
        }
        await rows.delete(where);
        continue;
      }
      if (item.itemKind === 'delay') {
        await arr.saveDelayProfile(item.before as unknown as ArrDelayProfile);
      } else if (item.itemKind === 'profile') {
        const before = item.before as unknown as ArrQualityProfile;
        await arr.saveProfile(before);
        await rows.update(where, {
          fingerprint: profileFingerprint(before, names),
          keptAsEdited: false,
        });
      } else {
        const before = item.before as unknown as ArrCustomFormat;
        await arr.saveFormat(before);
        await rows.update(where, {
          fingerprint: formatFingerprint(before),
          keptAsEdited: false,
        });
      }
      result.restored += 1;
    }
    entry.undoneAt = new Date();
    await repo.save(entry);
    logger.info('Quality profiles change undone', {
      label: LABEL,
      applyId,
      ...result,
    });
    return result;
  });
};

export type ServerStatus =
  | 'not-managed'
  | 'unsupported'
  | 'unreachable'
  | 'ready'
  | 'in-sync'
  | 'update-ready'
  | 'changed'
  | 'kept';

export interface ServerState {
  kind: ArrKind;
  serverId: number;
  name: string;
  is4k: boolean;
  status: ServerStatus;
  version?: string;
  /** Seerr AI's items someone changed or removed in Radarr or Sonarr. */
  changed: { name: string; removed: boolean }[];
  kept: string[];
  /**
   * TRaSH formats an admin moved whose TRaSH Guides score has changed since
   * it was applied: the admin's choice stays, and this says so.
   */
  clashes: string[];
  appliedAt?: string;
  sizesOnProfile?: boolean;
  /** Why it could not be reached. */
  error?: string;
}

const states = new Map<string, ServerState>();

/** The last state each server was seen in (for Health), by kind:id. */
export const lastStates = (): ServerState[] => [...states.values()];

/** Where one server stands: managed or not, in step, changed elsewhere. */
export const stateOf = async (ref: QualityServerRef): Promise<ServerState> => {
  const server = serverSettingsOf(ref);
  if (!server) throw new QualityError('not-found', 'There is no such server.');
  const config = configFor(ref);
  const base: ServerState = {
    kind: ref.kind,
    serverId: ref.serverId,
    name: server.name,
    is4k: server.is4k,
    status: 'not-managed',
    changed: [],
    kept: [],
    clashes: [],
  };
  const last = await getRepository(QualityApply).findOne({
    where: { serverKind: ref.kind, serverId: ref.serverId },
    order: { id: 'DESC' },
  });
  if (last) base.appliedAt = last.createdAt.toISOString();
  let state: ServerState;
  if (!config.managed) {
    state = base;
  } else {
    try {
      const plan = await planFor(ref);
      const formatNames = new Map(
        plan.ctx.formats
          .filter((f) => f.id !== undefined)
          .map((f) => [f.id as number, f.name])
      );
      const changed: ServerState['changed'] = [];
      const kept: string[] = [];
      for (const row of plan.rows) {
        const item =
          row.itemKind === 'profile'
            ? plan.ctx.profiles.find((p) => p.id === row.arrId)
            : plan.ctx.formats.find((f) => f.id === row.arrId);
        const name =
          item?.name ??
          (row.itemKind === 'profile'
            ? plan.desired.profiles.find((p) => p.preset === row.key)?.name
            : plan.desired.formats.find((f) => f.key === row.key)?.format
                .name) ??
          row.key;
        if (row.keptAsEdited) {
          kept.push(name);
          continue;
        }
        if (!item) {
          changed.push({ name, removed: true });
          continue;
        }
        const fingerprint =
          row.itemKind === 'profile'
            ? profileFingerprint(item as ArrQualityProfile, formatNames)
            : formatFingerprint(item as ArrCustomFormat);
        if (fingerprint !== row.fingerprint) {
          changed.push({ name, removed: false });
        }
      }
      const clashes = [
        ...new Set(
          plan.desired.profiles.flatMap((profile) =>
            profile.formats
              .filter(
                (f) =>
                  f.raw !== undefined &&
                  config.trashRaw?.[f.key] !== undefined &&
                  config.trashRaw[f.key] !== f.raw
              )
              .map((f) => f.name)
          )
        ),
      ];
      const pending = plan.preview.changes.some(
        (c) => c.action !== 'unchanged' && c.action !== 'kept'
      );
      const trash = await trashData();
      const usesTrash = Object.values(config.presets).includes('trash');
      state = {
        ...base,
        version: plan.ctx.version,
        sizesOnProfile: plan.ctx.facts.sizesOnProfile,
        changed,
        kept,
        clashes,
        status: changed.length
          ? 'changed'
          : !plan.rows.length
            ? 'ready'
            : pending
              ? usesTrash &&
                !!trash?.commit &&
                trash.commit !== config.trashCommit
                ? 'update-ready'
                : 'ready'
              : kept.length
                ? 'kept'
                : 'in-sync',
      };
    } catch (e) {
      state = {
        ...base,
        status:
          e instanceof QualityError && e.code === 'unsupported'
            ? 'unsupported'
            : 'unreachable',
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
  states.set(lockKey(ref), state);
  return state;
};

/**
 * Keeps changes someone made in Radarr or Sonarr to Seerr AI's items:
 * they are left as they are, and skipped, until someone puts them back.
 */
export const keepChanges = async (ref: QualityServerRef): Promise<number> => {
  const state = await stateOf(ref);
  const names = new Set(
    state.changed.filter((c) => !c.removed).map((c) => c.name)
  );
  if (!names.size) return 0;
  const ctx = await loadContext(ref);
  const rows = await rowsFor(ref);
  let kept = 0;
  for (const row of rows) {
    const item =
      row.itemKind === 'profile'
        ? ctx.profiles.find((p) => p.id === row.arrId)
        : ctx.formats.find((f) => f.id === row.arrId);
    if (item && names.has(item.name)) {
      row.keptAsEdited = true;
      await getRepository(QualityManaged).save(row);
      kept += 1;
    }
  }
  await stateOf(ref);
  return kept;
};

/** Every Radarr and Sonarr server, as refs. */
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
