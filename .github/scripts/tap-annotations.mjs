/* eslint-disable no-console -- its output is the annotations */
// Prints a node:test TAP report's failures, and its diagnostics, as GitHub
// Actions annotations, so a run's summary says what failed and why without
// its log having to be opened.
// usage: node tap-annotations.mjs <report.tap>
import { readFileSync } from 'node:fs';

const lines = readFileSync(process.argv[2], 'utf8').split('\n');

/** %, CR and LF are what an annotation's message must have escaped. */
const escape = (text) =>
  text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeTitle = (text) => escape(text).replace(/:/g, '%3A').replace(/,/g, '%2C');

/** The YAML block after a result line: from `---` to `...`. */
const blockAfter = (start) => {
  const block = [];
  if (!lines[start + 1]?.trim().startsWith('---')) {
    return block;
  }
  for (let i = start + 2; i < lines.length; i++) {
    if (lines[i].trim() === '...') {
      break;
    }
    block.push(lines[i]);
  }
  return block;
};

/** A key's value in the block, inline or as an indented `|-` block. */
const valueOf = (block, key) => {
  const at = block.findIndex((line) => line.trim().startsWith(`${key}:`));
  if (at < 0) {
    return '';
  }
  const inline = block[at].trim().slice(key.length + 1).trim();
  if (inline && !/^[|>]-?$/.test(inline)) {
    return inline.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
  }
  const indent = block[at].search(/\S/);
  const value = [];
  for (let i = at + 1; i < block.length; i++) {
    const own = block[i].search(/\S/);
    if (block[i].trim() && own <= indent) {
      break;
    }
    value.push(block[i].trim());
  }
  return value.join('\n').trim();
};

let failures = 0;
lines.forEach((line, i) => {
  const result = line.match(/^\s*not ok \d+ - (.*?)(?: # .*)?$/);
  if (result) {
    const block = blockAfter(i);
    // A suite fails when a test in it does: that test says why.
    if (valueOf(block, 'failureType') === 'subtestsFailed') {
      return;
    }
    failures += 1;
    if (failures > 10) {
      return;
    }
    // What it says, and where in the checks it was.
    const stack = valueOf(block, 'stack').split('\n');
    const where = stack.filter((frame) => frame.includes('.test.ts')).slice(0, 2);
    const why = [valueOf(block, 'error'), ...where].filter(Boolean).join('\n');
    console.log(`::error title=${escapeTitle(result[1])}::${escape(why || 'failed')}`);
    return;
  }
  const diagnostic = line.match(/^\s+# (?!Subtest: )(.+)$/);
  if (diagnostic && !/^(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /.test(diagnostic[1])) {
    console.log(`::notice::${escape(diagnostic[1])}`);
  }
});
if (failures > 10) {
  console.log(`::error::${failures - 10} more failed; see the log`);
}
