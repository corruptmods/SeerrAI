import dataSource, { getRepository } from '@server/datasource';
import AgentRun from '@server/entity/AgentRun';
import BackfillJob from '@server/entity/BackfillJob';
import BackfillSeries from '@server/entity/BackfillSeries';
import { AddAgentFollowUp1795100000000 as Postgres } from '@server/migration/postgres/1795100000000-AddAgentFollowUp';
import { AddAgentFollowUp1795100000000 as Sqlite } from '@server/migration/sqlite/1795100000000-AddAgentFollowUp';
import { setupTestDb } from '@server/test/db';
import { isPgsql } from '@server/utils/dbType';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * The admin agent's runs say what they are for. Runs from before that are
 * marked from what they remember: a change waiting for approval on
 * someone's behalf, and a replaced season being followed, are not the
 * agent's own work; everything else is.
 */

setupTestDb();

describe('marking what earlier admin agent runs were for', () => {
  it('tells approvals and followed seasons from work, and keeps failed downloads as they were', async () => {
    const migration = isPgsql ? new Postgres() : new Sqlite();
    const series = await getRepository(BackfillSeries).save(
      new BackfillSeries({
        kind: 'series',
        serverId: 0,
        arrId: 1,
        title: 'Slow Horses',
        status: 'none',
        missing: 1,
        searchTerms: [],
      })
    );
    const runner = dataSource.createQueryRunner();
    try {
      await migration.down(runner);
      const run = (trigger: string, memory: unknown) =>
        runner.query(
          `INSERT INTO "agent_run" ("trigger", "status", "memory") VALUES ('${trigger}', 'done', '${JSON.stringify(memory)}')`
        );
      await run('report', { direct: true, report: { replace: true } });
      await run('report', { report: { follow: { episodeIds: [5] } } });
      await run('report', { report: { issueId: 3 } });
      await run('auto', {});
      await runner.query(
        `INSERT INTO "backfill_job" ("seriesId", "title", "status", "protocol", "clientId") VALUES (${series.id}, 'Slow.Horses.S06E03-HONE', 'failed', 'usenet', 2)`
      );
      await migration.up(runner);
    } finally {
      await runner.release();
    }
    const runs = await getRepository(AgentRun).find({ order: { id: 'ASC' } });
    assert.deepEqual(
      runs.map((r) => [r.trigger, r.purpose]),
      [
        ['report', 'approval'],
        ['report', 'follow'],
        ['report', 'work'],
        ['auto', 'work'],
      ]
    );
    const [job] = await getRepository(BackfillJob).find();
    assert.deepEqual(
      [job.followUp, job.replacedById, job.agentRunId],
      [null, null, null]
    );
  });
});
