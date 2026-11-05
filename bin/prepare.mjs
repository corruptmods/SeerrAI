#!/usr/bin/env node

/** Skip husky in CI. */
const isCi = process.env.CI !== undefined;
if (!isCi) {
  const husky = (await import('husky')).default;
  console.log(husky());
}
