import { getRepository } from '@server/datasource';
import AgentRun from '@server/entity/AgentRun';
import { In } from 'typeorm';

export interface WorkedTitle {
  kind: 'series' | 'movie' | 'album';
  serverId: number;
  arrId: number;
}

const keyOf = (title: WorkedTitle) =>
  `${title.kind}:${title.serverId}:${title.arrId}`;

/**
 * The admin agent's run working on each of these titles right now (queued
 * or under way), the newest when there are several. Waiting for an admin's
 * answer is not working.
 */
export const agentWorkingOn = async (
  titles: WorkedTitle[]
): Promise<Map<string, number>> => {
  const working = new Map<string, number>();
  if (!titles.length) return working;
  const wanted = new Set(titles.map(keyOf));
  const runs = await getRepository(AgentRun).find({
    select: { id: true, kind: true, serverId: true, arrId: true },
    where: {
      status: In(['queued', 'running']),
      arrId: In([...new Set(titles.map((t) => t.arrId))]),
    },
    order: { id: 'ASC' },
  });
  for (const run of runs) {
    if (!run.kind || run.serverId == null || run.arrId == null) continue;
    const key = keyOf({
      kind: run.kind,
      serverId: run.serverId,
      arrId: run.arrId,
    });
    if (wanted.has(key)) working.set(key, run.id);
  }
  return working;
};

export const workedKey = keyOf;
