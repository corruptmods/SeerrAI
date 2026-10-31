import { escapesFolder } from '@server/lib/backfill/paths';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('a torrent’s file names', () => {
  it('stay inside its folder, or are refused', () => {
    for (const name of [
      'Brass Harbor/Season 1/Brass.Harbor.S01E01.mkv',
      'Brass.Harbor.S01E01.mkv',
      'Brass..Harbor/S01E01.mkv',
    ]) {
      assert.equal(escapesFolder(name), false, name);
    }
    for (const name of [
      '../elsewhere/file.mkv',
      'Brass Harbor/../../elsewhere/file.mkv',
      'Brass Harbor\\..\\file.mkv',
      '/data/elsewhere/file.mkv',
      'C:\\elsewhere\\file.mkv',
    ]) {
      assert.equal(escapesFolder(name), true, name);
    }
  });
});
