import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/*
 * Every label on a notification settings page (admin's and per-user) must
 * point at a control id on that page; otherwise a screen reader announces the
 * control without its name and clicking the label does nothing. Reads the
 * source, since the pages need the whole app to render.
 */

const SRC = path.join(__dirname, '../../..');
const FOLDERS = [
  'components/Settings/Notifications',
  'components/UserProfile/UserSettings/UserNotificationSettings',
];

const pages = (folder: string): string[] =>
  readdirSync(path.join(SRC, folder), { withFileTypes: true }).flatMap(
    (entry) =>
      entry.isDirectory()
        ? pages(path.join(folder, entry.name))
        : entry.name.endsWith('.tsx')
          ? [path.join(folder, entry.name)]
          : []
  );

/** Ids a page's labels point at, where written literally. */
const labelTargets = (source: string): string[] =>
  [...source.matchAll(/htmlFor=(?:"([^"]+)"|\{'([^']+)'\})/g)].map(
    (match) => match[1] ?? match[2]
  );

/** Ids a page gives its controls, where written literally. */
const controlIds = (source: string): Set<string> =>
  new Set(
    [...source.matchAll(/\b(?:id|inputId)=(?:"([^"]+)"|\{'([^']+)'\})/g)].map(
      (match) => match[1] ?? match[2]
    )
  );

describe('notification settings labels', () => {
  const files = FOLDERS.flatMap(pages);

  it('finds the pages', () => {
    assert.ok(files.length >= 15, `only ${files.length} pages found`);
  });

  for (const file of files) {
    it(`${path.basename(path.dirname(file))}/${path.basename(file)}: every label names a control`, () => {
      const source = readFileSync(path.join(SRC, file), 'utf8');
      const ids = controlIds(source);
      assert.deepEqual(
        labelTargets(source).filter((target) => !ids.has(target)),
        []
      );
    });
  }

  it('notices a label for a control that is not there', () => {
    const source = `<label htmlFor="webhookUrl">URL</label>
      <Field id="url" name="webhookUrl" />`;
    const ids = controlIds(source);
    assert.deepEqual(
      labelTargets(source).filter((target) => !ids.has(target)),
      ['webhookUrl']
    );
  });
});
