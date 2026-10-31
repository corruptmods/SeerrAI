import { getRepository } from '@server/datasource';
import QualityManaged from '@server/entity/QualityManaged';
import QualityStepDown from '@server/entity/QualityStepDown';
import type { QualityServerRef } from '@server/lib/quality/arr';
import { QualityArr } from '@server/lib/quality/arr';
import { allServers, configFor } from '@server/lib/quality/engine';
import { LOOSER } from '@server/lib/quality/presets';
import type { PresetKey } from '@server/lib/quality/types';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

/*
 * Backfill's step-down (Settings → Backfill, off by default): a movie or
 * series on one of Seerr AI's presets that nothing has been grabbed for
 * since it was added `days` ago moves to the next looser preset on its
 * server, so what exists can be had, and a search starts. Once it has a
 * file it goes back to its own profile, so the usual upgrades go on.
 */

const LABEL = 'Quality';
const DAY_MS = 24 * 60 * 60 * 1000;
/** Titles moved down per server per run, so indexers aren't flooded. */
const PER_RUN = 10;

export interface StepDownResult {
  down: number;
  back: number;
}

const stepServer = async (
  ref: QualityServerRef,
  enabled: boolean,
  days: number
): Promise<StepDownResult> => {
  const result = { down: 0, back: 0 };
  const steps = getRepository(QualityStepDown);
  const stepped = await steps.find({
    where: { serverKind: ref.kind, serverId: ref.serverId },
  });
  const config = configFor(ref);
  if (!stepped.length && (!enabled || !config.managed)) return result;
  const arr = QualityArr.forServer(ref);
  if (!arr) return result;
  const titles = await arr.titles();
  const byId = new Map(titles.map((t) => [t.id, t]));

  // Back up first: what has a file now, or was moved by someone else.
  for (const step of stepped) {
    const title = byId.get(step.arrId);
    if (!title || title.profileId !== step.toProfileId) {
      await steps.remove(step);
      continue;
    }
    if (title.hasFile) {
      await arr.moveTitles([title.id], step.fromProfileId);
      await steps.remove(step);
      result.back += 1;
    }
  }
  if (!enabled || !config.managed) return result;

  const rows = await getRepository(QualityManaged).find({
    where: {
      serverKind: ref.kind,
      serverId: ref.serverId,
      itemKind: 'profile',
    },
  });
  const presetOf = new Map(rows.map((r) => [r.arrId, r.key as PresetKey]));
  const profileOf = new Map(rows.map((r) => [r.key as PresetKey, r.arrId]));
  const already = new Set(stepped.map((s) => s.arrId));
  const cutoff = Date.now() - days * DAY_MS;
  const moves = new Map<number, number[]>();
  let count = 0;
  for (const title of titles) {
    if (count >= PER_RUN) break;
    const preset = presetOf.get(title.profileId);
    const looser = preset && LOOSER[preset];
    const to = looser && profileOf.get(looser);
    if (
      to === undefined ||
      already.has(title.id) ||
      title.hasFile ||
      !title.monitored ||
      !title.wanted ||
      !title.added ||
      Date.parse(title.added) > cutoff
    ) {
      continue;
    }
    await steps.save(
      new QualityStepDown({
        serverKind: ref.kind,
        serverId: ref.serverId,
        arrId: title.id,
        title: title.title,
        fromProfileId: title.profileId,
        toProfileId: to,
      })
    );
    moves.set(to, [...(moves.get(to) ?? []), title.id]);
    count += 1;
  }
  for (const [to, ids] of moves) {
    await arr.moveTitles(ids, to);
    await arr.search(ids).catch(() => undefined);
    result.down += ids.length;
  }
  return result;
};

/** One run over every server: titles back up, then titles down. */
export const runStepDown = async (): Promise<StepDownResult> => {
  const { enabled, days } = getSettings().backfill.stepDown;
  const total = { down: 0, back: 0 };
  for (const ref of allServers()) {
    try {
      const result = await stepServer(ref, enabled, days);
      total.down += result.down;
      total.back += result.back;
    } catch (e) {
      logger.warn('Step-down could not run on a server', {
        label: LABEL,
        server: `${ref.kind} ${ref.serverId}`,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
  }
  if (total.down || total.back) {
    logger.info('Step-down moved titles', { label: LABEL, ...total });
  }
  return total;
};
