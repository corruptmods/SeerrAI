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
import type {
  ArrDelayProfile,
  ArrTitle,
  QualityServerRef,
} from '@server/lib/quality/arr';
import { QualityArr, serverSettingsOf } from '@server/lib/quality/arr';
import type { DesiredDelay, DesiredState } from '@server/lib/quality/build';
import { materialize } from '@server/lib/quality/build';
import type { Plan, Preview } from '@server/lib/quality/plan';
import {
  QualityError,
  choicesOf,
  configFor,
  defaultDelay,
  formatFingerprint,
  formatMatches,
  matchProfile,
  namesOf,
  planFor,
  profileFingerprint,
  rowsFor,
  withBlockScore,
} from '@server/lib/quality/plan';
import type {
  ArrKind,
  PresetKey,
  QualityServerSettings,
} from '@server/lib/quality/types';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import axios from 'axios';
import { IsNull } from 'typeorm';

/*
 * Settings → Quality's work on a server: applying a preview, undoing an
 * apply, and noticing when someone changed one of Seerr AI's profiles in
 * Radarr or Sonarr itself. Only what Seerr AI created is ever written, and
 * the default delay profile; nothing is written to a server an admin
 * hasn't chosen to manage. What applying would change is lib/quality/plan.
 */

export { QualityError, allServers, configFor } from '@server/lib/quality/plan';
export type {
  ChangeDetail,
  Preview,
  PreviewChange,
} from '@server/lib/quality/plan';

const LABEL = 'Quality';

/** What applying would change, without changing anything. */
export const preview = async (
  ref: QualityServerRef,
  options: { restoreKept?: boolean } = {}
): Promise<Preview> => {
  const plan = await planFor(ref, options);
  const titles = await plan.ctx.arr.titles().catch(() => []);
  for (const profile of plan.preview.ownProfiles) {
    profile.titles = titles.filter((t) => t.profileId === profile.id).length;
  }
  return plan.preview;
};

const busy = new Set<string>();
const keyOf = (ref: QualityServerRef) => `${ref.kind}:${ref.serverId}`;

/** One apply, undo or keep at a time on a server. */
const withLock = async <T>(
  ref: QualityServerRef,
  work: () => Promise<T>
): Promise<T> => {
  const key = keyOf(ref);
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

/** Changes a server's saved choices without touching the rest. */
const updateSaved = async (
  ref: QualityServerRef,
  change: (saved: QualityServerSettings) => QualityServerSettings
) => {
  const settings = getSettings();
  const quality = settings.quality;
  quality.servers = quality.servers.map((s) =>
    s.kind === ref.kind && s.serverId === ref.serverId ? change(s) : s
  );
  settings.quality = quality;
  await settings.save();
};

export interface ApplyOptions {
  /** Titles on one of the admin's own profiles to move onto a preset's. */
  move?: { fromProfileId: number; preset: PresetKey }[];
  /** Puts back profiles and formats someone chose to keep as edited. */
  restoreKept?: boolean;
  /** The preview's token: nothing is changed unless it still holds. */
  token?: string;
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

/** What an apply has done so far, for History and Undo. */
interface Done {
  befores: QualityBefore[];
  moved: QualityMovedTitle[];
  created: number;
  updated: number;
}

export type ApplyStep =
  | 'formats'
  | 'profiles'
  | 'delay'
  | 'requests'
  | 'titles';

/** An apply under way, for the page's progress bar. */
export interface ApplyProgress {
  step: ApplyStep;
  done: number;
  total: number;
}

const running = new Map<
  string,
  { step: ApplyStep; done: Done; total: number; titlesDone: number }
>();

/** How far an apply on a server has got; null when none is running. */
export const applyProgress = (ref: QualityServerRef): ApplyProgress | null => {
  const live = running.get(keyOf(ref));
  if (!live) return null;
  return {
    step: live.step,
    done: Math.min(
      live.total,
      live.done.created + live.done.updated + live.titlesDone
    ),
    total: live.total,
  };
};

const writeFormats = async (plan: Plan, done: Done) => {
  const { ctx, desired, formatIds } = plan;
  const ref = ctx.ref;
  const changes = plan.preview.changes;
  for (const def of desired.formats) {
    const change = changes.find(
      (c) => c.itemKind === 'format' && c.key === def.key
    );
    if (!change || change.action === 'kept') continue;
    const current = ctx.formats.find((f) => f.id === formatIds.get(def.key));
    if (current?.id === undefined) {
      const saved = await ctx.arr.saveFormat(def.format);
      if (saved.id === undefined) continue;
      done.befores.push({
        itemKind: 'format',
        key: def.key,
        arrId: saved.id,
        before: null,
      });
      done.created += 1;
      formatIds.set(def.key, saved.id);
      await saveRow(ref, 'format', def.key, saved.id, formatFingerprint(saved));
    } else if (change.action === 'update' || change.action === 'put-back') {
      const saved = await ctx.arr.saveFormat({ ...def.format, id: current.id });
      done.befores.push({
        itemKind: 'format',
        key: def.key,
        arrId: current.id,
        before: current as unknown as Record<string, unknown>,
      });
      done.updated += 1;
      await saveRow(
        ref,
        'format',
        def.key,
        current.id,
        formatFingerprint(saved ?? def.format)
      );
    } else {
      await saveRow(
        ref,
        'format',
        def.key,
        current.id,
        formatFingerprint(current)
      );
    }
  }
};

/** Writes the profiles; answers each preset's profile id. */
const writeProfiles = async (
  plan: Plan,
  done: Done
): Promise<Map<PresetKey, number>> => {
  const { ctx, desired, rows, formatIds } = plan;
  const ref = ctx.ref;
  // The formats as they are now, with any just created.
  const formats = await ctx.arr.formats();
  const names = namesOf(formats);
  const profileIds = new Map<PresetKey, number>();
  for (const profile of desired.profiles) {
    const change = plan.preview.changes.find(
      (c) => c.itemKind === 'profile' && c.key === profile.preset
    );
    const { current } = matchProfile(ctx, profile, rows);
    if (current) profileIds.set(profile.preset, current.id);
    if (!change || change.action === 'kept') continue;
    const next = withBlockScore(
      materialize(profile, ctx.facts, formatIds, formats, new Map()),
      formats
    );
    if (!current) {
      const saved = await ctx.arr.createProfile(next);
      profileIds.set(profile.preset, saved.id);
      done.befores.push({
        itemKind: 'profile',
        key: profile.preset,
        arrId: saved.id,
        before: null,
      });
      done.created += 1;
      await saveRow(
        ref,
        'profile',
        profile.preset,
        saved.id,
        profileFingerprint(saved, names)
      );
    } else if (change.action === 'update' || change.action === 'put-back') {
      const saved = await ctx.arr.saveProfile({ ...next, id: current.id });
      done.befores.push({
        itemKind: 'profile',
        key: profile.preset,
        arrId: current.id,
        before: current as unknown as Record<string, unknown>,
      });
      done.updated += 1;
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
  return profileIds;
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

const writeDelay = async (plan: Plan, done: Done) => {
  const delay = defaultDelay(plan.ctx.delays);
  const change = plan.preview.changes.find((c) => c.itemKind === 'delay');
  if (!plan.desired.delay || !delay || change?.action !== 'update') return;
  await plan.ctx.arr.saveDelayProfile(delayWith(delay, plan.desired.delay));
  done.befores.push({
    itemKind: 'delay',
    key: 'delay',
    arrId: delay.id,
    before: delay as unknown as Record<string, unknown>,
  });
  done.updated += 1;
};

/** The request settings an apply changed, as they were before it. */
interface RequestDefaults {
  main?: { id: number; name: string };
  anime?: { id?: number; name?: string };
}

/**
 * Points new requests to this server (its Services settings) at the
 * presets' profiles, as the preview showed.
 */
const writeRequests = async (
  plan: Plan,
  profileIds: Map<PresetKey, number>,
  done: Done
) => {
  const change = plan.preview.changes.find((c) => c.itemKind === 'requests');
  const server = serverSettingsOf(plan.ctx.ref);
  if (!change || !server) return;
  const before: RequestDefaults = {};
  for (const detail of change.details) {
    if (detail.kind !== 'requests') continue;
    const id = profileIds.get(detail.preset);
    if (id === undefined) continue;
    if (detail.which === 'main') {
      before.main = {
        id: server.activeProfileId,
        name: server.activeProfileName,
      };
      server.activeProfileId = id;
      server.activeProfileName = detail.to;
    } else {
      before.anime = {
        id: server.activeAnimeProfileId,
        name: server.activeAnimeProfileName,
      };
      server.activeAnimeProfileId = id;
      server.activeAnimeProfileName = detail.to;
    }
  }
  if (!before.main && !before.anime) return;
  await getSettings().save();
  done.befores.push({
    itemKind: 'requests',
    key: 'requests',
    arrId: 0,
    before: before as unknown as Record<string, unknown>,
  });
  done.updated += 1;
};

/**
 * Puts the request settings an apply changed back as they were, where
 * they still send requests to one of Seerr AI's profiles (an admin may
 * have chosen another since).
 */
const restoreRequests = async (
  ref: QualityServerRef,
  before: RequestDefaults,
  ours: Set<number>
): Promise<boolean> => {
  const server = serverSettingsOf(ref);
  if (!server) return false;
  let changed = false;
  if (before.main && ours.has(server.activeProfileId)) {
    server.activeProfileId = before.main.id;
    server.activeProfileName = before.main.name;
    changed = true;
  }
  if (
    before.anime &&
    server.activeAnimeProfileId !== undefined &&
    ours.has(server.activeAnimeProfileId)
  ) {
    server.activeAnimeProfileId = before.anime.id;
    server.activeAnimeProfileName = before.anime.name;
    changed = true;
  }
  if (changed) await getSettings().save();
  return changed;
};

/** Moves titles off the admin's own profiles, as the preview offered. */
const moveOwnTitles = async (
  plan: Plan,
  move: NonNullable<ApplyOptions['move']>,
  profileIds: Map<PresetKey, number>,
  done: Done
) => {
  // Only the admin's own profiles, as the preview listed them.
  const own = new Set(plan.preview.ownProfiles.map((p) => p.id));
  const wanted = new Map<number, number>();
  for (const { fromProfileId, preset } of move) {
    const to = profileIds.get(preset);
    if (to !== undefined && own.has(fromProfileId)) {
      wanted.set(fromProfileId, to);
    }
  }
  if (!wanted.size) return;
  const titles = await plan.ctx.arr.titles();
  for (const [fromProfileId, to] of wanted) {
    const ids = titles
      .filter((t) => t.profileId === fromProfileId)
      .map((t) => t.id);
    await plan.ctx.arr.moveTitles(ids, to);
    done.moved.push(...ids.map((arrId) => ({ arrId, fromProfileId })));
  }
};

/** Keeps an apply in History, so it can be undone; null when it did nothing. */
const record = async (
  ref: QualityServerRef,
  done: Done,
  options: ApplyOptions
): Promise<number | null> => {
  if (!done.befores.length && !done.moved.length) return null;
  const entry = await getRepository(QualityApply).save(
    new QualityApply({
      serverKind: ref.kind,
      serverId: ref.serverId,
      userId: options.userId ?? null,
      summary: {
        created: done.created,
        updated: done.updated,
        ...(options.trash ? { trash: true } : {}),
      },
      befores: done.befores,
      moved: done.moved,
      undoneAt: null,
    })
  );
  return entry.id;
};

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

/** Applies a server's choices: the preview, made so. */
export const apply = async (
  ref: QualityServerRef,
  options: ApplyOptions = {}
): Promise<ApplyResult> =>
  withLock(ref, async () => {
    const plan = await planFor(ref, { restoreKept: options.restoreKept });
    if (options.token !== undefined && options.token !== plan.preview.token) {
      throw new QualityError(
        'stale',
        'What applying would change is different now. Preview it again.'
      );
    }
    if (
      options.trash &&
      (plan.config.appliedChoices !== choicesOf(plan.config, plan.fillGaps) ||
        plan.preview.changes.some((c) => c.action === 'put-back'))
    ) {
      // Choices saved but not applied, or something changed in the app
      // since the last check: those wait for an admin's preview.
      throw new QualityError(
        'stale',
        'There are changes besides TRaSH Guides; they wait for an admin.'
      );
    }
    const done: Done = { befores: [], moved: [], created: 0, updated: 0 };
    // Each item to write counts one, and moving titles one more.
    const writes = plan.preview.changes.filter(
      (c) =>
        c.action !== 'unchanged' &&
        c.action !== 'kept' &&
        !(
          options.trash &&
          (c.itemKind === 'delay' || c.itemKind === 'requests')
        )
    ).length;
    const live = {
      step: 'formats' as ApplyStep,
      done,
      total: writes + (options.move?.length ? 1 : 0),
      titlesDone: 0,
    };
    running.set(keyOf(ref), live);
    try {
      // Formats first: the profiles score them by their ids.
      await writeFormats(plan, done);
      live.step = 'profiles';
      const profileIds = await writeProfiles(plan, done);
      // A TRaSH Guides update never changes the delay profile, nor where
      // requests go.
      if (!options.trash) {
        live.step = 'delay';
        await writeDelay(plan, done);
        live.step = 'requests';
        await writeRequests(plan, profileIds, done);
      }
      if (options.move?.length) {
        live.step = 'titles';
        await moveOwnTitles(plan, options.move, profileIds, done);
        live.titlesDone = 1;
      }
    } catch (e) {
      // What was done before it failed can still be undone.
      const applyId = await record(ref, done, options).catch(() => null);
      logger.warn('Quality profiles only partly applied', {
        label: LABEL,
        server: plan.ctx.name,
        applyId,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      throw e;
    } finally {
      running.delete(keyOf(ref));
    }

    const applyId = await record(ref, done, options);
    // Only what this apply decides; the choices may have been saved anew
    // meanwhile, and stay as saved.
    const { config, desired, trash, fillGaps } = plan;
    const usesTrash = Object.values(config.presets).includes('trash');
    await updateSaved(ref, (saved) => ({
      ...saved,
      trashCommit: usesTrash ? trash?.commit : undefined,
      trashRaw: trashRawOf(desired, config),
      appliedChoices: choicesOf(config, fillGaps),
    }));
    logger.info('Quality profiles applied', {
      label: LABEL,
      server: plan.ctx.name,
      created: done.created,
      updated: done.updated,
      moved: done.moved.length,
    });
    return {
      applyId,
      created: done.created,
      updated: done.updated,
      moved: done.moved.length,
    };
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

/**
 * A profile as it was, scoring every format the server has now (the apps
 * take nothing less): formats made since score 0, and the blocked release
 * groups format as it is scored everywhere.
 */
const withFormatsNow = (
  profile: ArrQualityProfile,
  formats: ArrCustomFormat[]
): ArrQualityProfile => {
  const scores = new Map(
    (profile.formatItems ?? []).map((item) => [item.format, item.score])
  );
  return withBlockScore(
    {
      ...profile,
      formatItems: [...namesOf(formats)].map(([format, name]) => ({
        format,
        name,
        score: scores.get(format) ?? 0,
      })),
    },
    formats
  );
};

const gone = (e: unknown) =>
  axios.isAxiosError(e) && e.response?.status === 404;

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
  const found = await repo.findOne({ where: { id: applyId } });
  if (!found) throw new QualityError('not-found', 'There is no such apply.');
  const ref = { kind: found.serverKind, serverId: found.serverId };
  return withLock(ref, async () => {
    // Read again: another apply or undo may have finished meanwhile.
    const entry = await repo.findOne({ where: { id: applyId } });
    if (!entry) throw new QualityError('not-found', 'There is no such apply.');
    if (entry.undoneAt) {
      throw new QualityError('already-undone', 'It was already undone.');
    }
    const newer = await repo.findOne({
      where: {
        serverKind: ref.kind,
        serverId: ref.serverId,
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
    if (!configFor(ref).managed) {
      throw new QualityError(
        'not-managed',
        'Seerr AI does not manage this server. Manage it to undo.'
      );
    }
    const arr = QualityArr.forServer(ref);
    if (!arr) throw new QualityError('not-found', 'There is no such server.');
    const result: UndoResult = {
      restored: 0,
      removed: 0,
      keptInUse: [],
      movedBack: 0,
    };
    const [profiles, formats, managed] = await Promise.all([
      arr.profiles(),
      arr.formats(),
      rowsFor(ref),
    ]);
    const ours = new Set(
      managed.filter((r) => r.itemKind === 'profile').map((r) => r.arrId)
    );
    let titles: ArrTitle[] | undefined;

    // Titles first, so a profile they were moved onto is free to go. Only
    // those still on one of Seerr AI's, back to a profile that is there.
    if (entry.moved.length) {
      titles = await arr.titles();
      const onOurs = new Set(
        titles.filter((t) => ours.has(t.profileId)).map((t) => t.id)
      );
      const there = new Set(profiles.map((p) => p.id));
      const byFrom = new Map<number, number[]>();
      for (const move of entry.moved) {
        if (!onOurs.has(move.arrId) || !there.has(move.fromProfileId)) continue;
        byFrom.set(move.fromProfileId, [
          ...(byFrom.get(move.fromProfileId) ?? []),
          move.arrId,
        ]);
      }
      for (const [profileId, ids] of byFrom) {
        await arr.moveTitles(ids, profileId);
        result.movedBack += ids.length;
        const moved = new Set(ids);
        titles = titles.map((t) => (moved.has(t.id) ? { ...t, profileId } : t));
      }
    }

    // Where requests go first, so a profile it pointed them at is free.
    for (const item of entry.befores) {
      if (item.itemKind !== 'requests' || !item.before) continue;
      const put = await restoreRequests(
        ref,
        item.before as unknown as RequestDefaults,
        ours
      );
      if (put) result.restored += 1;
    }

    const names = namesOf(formats);
    const needed = inUseBySettings(ref);
    const rows = getRepository(QualityManaged);
    // Profiles, then the delay profile, then formats.
    const rank = { profile: 0, delay: 1, format: 2 };
    const order = entry.befores
      .filter((item) => item.itemKind !== 'requests')
      .sort(
        (a, b) =>
          rank[a.itemKind as keyof typeof rank] -
          rank[b.itemKind as keyof typeof rank]
      );
    for (const item of order) {
      const where = {
        serverKind: ref.kind,
        serverId: ref.serverId,
        itemKind: item.itemKind as 'profile' | 'format',
        key: item.key,
      };
      if (item.before === null && item.itemKind === 'profile') {
        titles ??= await arr.titles();
        const name =
          profiles.find((p) => p.id === item.arrId)?.name ?? String(item.arrId);
        const used =
          needed.has(item.arrId) ||
          titles.some((t) => t.profileId === item.arrId);
        if (used) {
          result.keptInUse.push(name);
          continue;
        }
        try {
          await arr.deleteProfile(item.arrId);
        } catch (e) {
          // Radarr and Sonarr refuse a profile something else uses.
          if (!gone(e)) {
            result.keptInUse.push(name);
            continue;
          }
        }
        await rows.delete(where);
        result.removed += 1;
      } else if (item.before === null) {
        if (item.itemKind !== 'format') continue;
        try {
          await arr.deleteFormat(item.arrId);
        } catch (e) {
          if (!gone(e)) throw e;
        }
        await rows.delete(where);
        result.removed += 1;
      } else if (item.itemKind === 'delay') {
        await arr.saveDelayProfile(item.before as unknown as ArrDelayProfile);
        result.restored += 1;
      } else if (item.itemKind === 'profile') {
        const before = withFormatsNow(
          item.before as unknown as ArrQualityProfile,
          formats
        );
        const saved = await arr.saveProfile(before);
        await rows.update(where, {
          fingerprint: profileFingerprint(saved, names),
          keptAsEdited: false,
        });
        result.restored += 1;
      } else {
        const before = item.before as unknown as ArrCustomFormat;
        const saved = await arr.saveFormat(before);
        await rows.update(where, {
          fingerprint: formatFingerprint(saved ?? before),
          keptAsEdited: false,
        });
        result.restored += 1;
      }
    }
    entry.undoneAt = new Date();
    await repo.save(entry);
    // The server no longer has the choices last applied: nothing is
    // applied on its own until an admin applies again.
    await updateSaved(ref, (saved) => ({
      ...saved,
      appliedChoices: undefined,
    }));
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

/** Seerr AI's items changed or removed in the app, and those kept so. */
const driftOf = (plan: Plan) => {
  const formatNames = namesOf(plan.ctx.formats);
  const changed: { row: QualityManaged; name: string; removed: boolean }[] = [];
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
        : plan.desired.formats.find((f) => f.key === row.key)?.format.name) ??
      row.key;
    if (row.keptAsEdited) {
      kept.push(name);
    } else if (!item) {
      changed.push({ row, name, removed: true });
    } else {
      const same =
        row.itemKind === 'profile'
          ? profileFingerprint(item as ArrQualityProfile, formatNames) ===
            row.fingerprint
          : formatMatches(item as ArrCustomFormat, row.fingerprint);
      if (!same) changed.push({ row, name, removed: false });
    }
  }
  return { changed, kept };
};

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
      const { changed, kept } = driftOf(plan);
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
      // Only a newer TRaSH Guides on choices already applied; choices
      // saved since wait for an admin's preview.
      const trashUpdate =
        Object.values(config.presets).includes('trash') &&
        !!plan.trash?.commit &&
        plan.trash.commit !== config.trashCommit &&
        config.appliedChoices === choicesOf(config, plan.fillGaps);
      state = {
        ...base,
        version: plan.ctx.version,
        sizesOnProfile: plan.ctx.facts.sizesOnProfile,
        changed: changed.map(({ name, removed }) => ({ name, removed })),
        kept,
        clashes,
        status: changed.length
          ? 'changed'
          : !plan.rows.length
            ? 'ready'
            : pending
              ? trashUpdate
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
  states.set(keyOf(ref), state);
  return state;
};

/**
 * Keeps changes someone made in Radarr or Sonarr to Seerr AI's items:
 * they are left as they are, and skipped, until someone puts them back.
 */
export const keepChanges = async (ref: QualityServerRef): Promise<number> =>
  withLock(ref, async () => {
    const { changed } = driftOf(await planFor(ref));
    let kept = 0;
    for (const { row, removed } of changed) {
      if (removed) continue;
      row.keptAsEdited = true;
      await getRepository(QualityManaged).save(row);
      kept += 1;
    }
    await stateOf(ref);
    return kept;
  });
