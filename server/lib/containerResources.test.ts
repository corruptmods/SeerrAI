import {
  countCpus,
  createResourceMonitor,
} from '@server/lib/containerResources';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

/*
 * Seerr's own container use, read from a fake cgroup tree in each layout,
 * with readings taken at chosen times.
 */

const GiB = 1024 ** 3;

const tree = (files: Record<string, string>) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cgroup-'));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), `${content}\n`);
  }
  return {
    root,
    set: (file: string, content: string) =>
      writeFileSync(path.join(root, file), `${content}\n`),
  };
};

const v2 = () =>
  tree({
    'memory.current': String(1.5 * GiB),
    'memory.max': String(4 * GiB),
    'memory.stat': `anon 100\ninactive_file ${0.5 * GiB}\nactive_file 5`,
    'cpu.stat': 'usage_usec 1000000\nuser_usec 800000',
    'cpu.max': '200000 100000',
    'cpuset.cpus.effective': '0-7',
    'pids.current': '42',
    'pids.max': 'max',
  });

describe('container resources', () => {
  it('reads memory, its limit and processes (cgroup v2)', async () => {
    const monitor = createResourceMonitor(v2().root);
    const { memory, processes, inContainer } = await monitor.tick(1_000);
    assert.equal(inContainer, true);
    assert.equal(memory?.used, 1 * GiB, 'cache the kernel can drop left out');
    assert.equal(memory?.limit, 4 * GiB);
    assert.deepEqual(processes, { current: 42, limit: null });
  });

  it('measures CPU as a share of the CPUs it may use', async () => {
    const cg = v2();
    const monitor = createResourceMonitor(cg.root);
    const first = await monitor.tick(10_000);
    assert.equal(first.cpu?.percent, null, 'nothing to compare yet');
    assert.equal(first.cpu?.cores, 2, 'the quota of 2 CPUs, not all 8');

    // One second of CPU time over ten seconds, on 2 CPUs: 5%.
    cg.set('cpu.stat', 'usage_usec 2000000');
    const second = await monitor.tick(20_000);
    assert.equal(second.cpu?.percent, 5);
  });

  it('treats no memory limit as none, and reads cgroup v1', async () => {
    const cg = tree({
      'memory/memory.usage_in_bytes': String(2 * GiB),
      'memory/memory.limit_in_bytes': '9223372036854771712',
      'memory/memory.stat': `inactive_file 1\ntotal_inactive_file ${GiB}`,
      'cpuacct/cpuacct.usage': '5000000000',
      'cpu/cpu.cfs_quota_us': '-1',
      'cpu/cpu.cfs_period_us': '100000',
      'cpuset/cpuset.effective_cpus': '0',
    });
    const monitor = createResourceMonitor(cg.root);
    const first = await monitor.tick(0);
    assert.equal(first.memory?.used, GiB);
    assert.equal(first.memory?.limit, null);
    assert.equal(first.cpu?.cores, 1);

    cg.set('cpuacct/cpuacct.usage', '5500000000'); // +0.5 s of CPU in ns
    const second = await monitor.tick(1_000);
    assert.equal(second.cpu?.percent, 50);
  });

  it('says so outside a container', async () => {
    const monitor = createResourceMonitor(tree({}).root);
    const reading = await monitor.tick(0);
    assert.equal(reading.inContainer, false);
    assert.ok(reading.node.rss > 0, 'still reports its own process');
  });

  it('keeps an hour of readings and a day of five-minute averages', async () => {
    const cg = v2();
    const monitor = createResourceMonitor(cg.root);
    const start = Date.parse('2026-09-26T00:00:00Z');
    let usage = 1_000_000;
    // Two hours at 15 s, using 10% of the 2 CPUs throughout.
    for (let t = 0; t <= 2 * 3600_000; t += 15_000) {
      cg.set('cpu.stat', `usage_usec ${usage}`);
      await monitor.tick(start + t);
      usage += 3_000_000; // 3 s of CPU per 15 s on 2 CPUs = 10%
    }
    const history = await monitor.history();
    const hour = history.recent;
    assert.ok(hour.length >= 239 && hour.length <= 241, `${hour.length}`);
    assert.ok(hour[0].t > start + 3600_000 - 1, 'only the last hour');
    assert.ok(history.day.length >= 23 && history.day.length <= 25);
    for (const point of history.day) {
      if (point.cpu !== null) {
        assert.ok(Math.abs(point.cpu - 10) < 0.01, `${point.cpu}`);
      }
      assert.equal(point.memory, GiB);
    }
  });

  it('counts CPU lists', () => {
    assert.equal(countCpus('0-3,6'), 5);
    assert.equal(countCpus('2'), 1);
    assert.equal(countCpus(''), undefined);
  });
});
