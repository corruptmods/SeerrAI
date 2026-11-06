import { escapesFolder, mapRemotePath } from '@server/lib/backfill/paths';
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

describe('a client path as the app sees it', () => {
  const mappings = [
    { host: 'qbit', remotePath: '/downloads', localPath: '/data/torrents/' },
    { host: 'qbit', remotePath: 'D:\\Downloads\\', localPath: '/data/win/' },
  ];

  it('is mapped only inside the remote folder itself', () => {
    assert.equal(
      mapRemotePath('/downloads/Glasswing/a.mkv', 'qbit', mappings),
      '/data/torrents/Glasswing/a.mkv'
    );
    assert.equal(
      mapRemotePath('/downloads', 'qbit', mappings),
      '/data/torrents/'
    );
    assert.equal(
      mapRemotePath('/downloads2/Glasswing/a.mkv', 'qbit', mappings),
      '/downloads2/Glasswing/a.mkv'
    );
    assert.equal(
      mapRemotePath('d:\\downloads\\Static Garden\\b.mkv', 'qbit', mappings),
      '/data/win/Static Garden/b.mkv'
    );
    assert.equal(
      mapRemotePath('D:\\Downloads2\\b.mkv', 'qbit', mappings),
      'D:\\Downloads2\\b.mkv'
    );
  });
});
