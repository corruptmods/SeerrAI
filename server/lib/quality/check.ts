import {
  allServers,
  apply,
  configFor,
  stateOf,
} from '@server/lib/quality/engine';
import { runStepDown } from '@server/lib/quality/stepDown';
import { refreshTrashIfOlder } from '@server/lib/quality/trash';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

/*
 * The Quality Profiles Check job, hourly: TRaSH Guides once every 24 hours
 * while a managed server uses it, each managed server's state (what Health shows),
 * TRaSH Guides updates applied on their own only when an admin turned that
 * on, and the Backfill step-down every six hours.
 */

const LABEL = 'Quality';
const HOUR_MS = 60 * 60 * 1000;
let lastStepDown = 0;
let running = false;

export const qualityCheckRunning = () => running;

export const runQualityCheck = async (): Promise<void> => {
  if (running) return;
  running = true;
  try {
    const quality = getSettings().quality;
    const usesTrash = quality.servers.some(
      (s) => s.managed && Object.values(s.presets).includes('trash')
    );
    if (usesTrash) await refreshTrashIfOlder(24 * HOUR_MS);
    for (const ref of allServers()) {
      if (!configFor(ref).managed) continue;
      const state = await stateOf(ref);
      if (quality.trash.autoApply && state.status === 'update-ready') {
        try {
          await apply(ref, { trash: true, userId: null });
        } catch (e) {
          logger.warn('Could not apply a TRaSH Guides update', {
            label: LABEL,
            server: state.name,
            errorMessage: e instanceof Error ? e.message : String(e),
          });
        }
        await stateOf(ref);
      }
    }
    const backfill = getSettings().backfill;
    if (Date.now() - lastStepDown > 6 * HOUR_MS) {
      lastStepDown = Date.now();
      if (backfill.stepDown.enabled || quality.servers.some((s) => s.managed)) {
        await runStepDown();
      }
    }
  } finally {
    running = false;
  }
};
