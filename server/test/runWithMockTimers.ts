import { mock } from 'node:test';

export async function runWithMockTimers<T>(
  runFn: () => Promise<T>,
  tickMs = 4000
): Promise<T> {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let settled = false;
    const runPromise = runFn();
    runPromise
      .catch(() => undefined)
      .finally(() => {
        settled = true;
      });
    const maxTicks = 100000;
    for (let i = 0; i < maxTicks && !settled; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      mock.timers.tick(tickMs);
    }
    // The final tick may have settled runPromise, but `settled` updates in a
    // microtask; yield once more so a resolve on the last iteration isn't
    // missed.
    await new Promise((resolve) => setImmediate(resolve));
    if (!settled) {
      throw new Error(
        `runWithMockTimers: promise did not settle after ${maxTicks} ticks`
      );
    }
    return await runPromise;
  } finally {
    mock.timers.reset();
  }
}
