import { MediaStatus } from '@server/constants/media';
import { artistStatus, lidarrStatus } from '@server/lib/music/availability';
import {
  folderName,
  matchByFolderOrTitle,
  normalizeName,
  parentPath,
} from '@server/lib/music/matcher';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * The plain rules behind music matching and status: names and folders as
 * compared, which album a folder or title is, and how an artist's status
 * follows their albums'.
 */

describe('names and folders', () => {
  it('are compared without case, accents, “the”, “&” or punctuation', () => {
    assert.equal(normalizeName('The Beatles'), normalizeName('beatles'));
    assert.equal(normalizeName('Björk'), 'bjork');
    assert.equal(normalizeName('Simon & Garfunkel'), 'simonandgarfunkel');
    assert.equal(normalizeName('OK Computer (1997)'), 'okcomputer1997');
    assert.equal(normalizeName('坂本龍一'), '坂本龍一');
    assert.equal(normalizeName(undefined), '');
  });

  it('takes the last folder of a path, either kind of slash', () => {
    assert.equal(folderName('/music/Radiohead/Kid A/'), 'Kid A');
    assert.equal(folderName('D:\\Music\\Radiohead\\Kid A'), 'Kid A');
    assert.equal(
      parentPath('/music/Radiohead/Kid A/01.flac'),
      '/music/Radiohead/Kid A'
    );
    assert.equal(parentPath('/music/Radiohead/'), '/music');
    assert.equal(folderName(undefined), undefined);
  });
});

describe('matching an album by folder or title', () => {
  const candidates = [
    { mbid: 'hail', title: 'Hail to the Thief', releaseDate: '2003-06-09' },
    { mbid: 'kid-a', title: 'Kid A', releaseDate: '2000-10-02' },
    { mbid: 'live', title: 'Live', releaseDate: '1994' },
    { mbid: 'live-2', title: 'Live', releaseDate: '2001' },
    { mbid: 'kept', title: 'Bootleg', folder: 'bootleg-1995' },
  ];

  it('matches the folder against a title, with or without its year', () => {
    assert.equal(
      matchByFolderOrTitle(
        { path: '/m/Radiohead/Hail to the Thief (2003)', title: 'x' },
        candidates
      ),
      'hail'
    );
    assert.equal(
      matchByFolderOrTitle(
        { path: '/m/Radiohead/Kid A', title: 'x' },
        candidates
      ),
      'kid-a'
    );
    // A folder Seerr saw this album in before.
    assert.equal(
      matchByFolderOrTitle(
        { path: '/m/R/Bootleg-1995', title: 'x' },
        candidates
      ),
      'kept'
    );
  });

  it('then the title and year, and only a single match', () => {
    assert.equal(matchByFolderOrTitle({ title: 'KID A' }, candidates), 'kid-a');
    assert.equal(
      matchByFolderOrTitle({ title: 'Live', year: 2001 }, candidates),
      'live-2'
    );
    // Two albums of that name and no year to tell them apart.
    assert.equal(
      matchByFolderOrTitle({ title: 'Live' }, candidates),
      undefined
    );
    assert.equal(
      matchByFolderOrTitle({ title: 'Kid A', year: 2009 }, candidates),
      undefined
    );
    assert.equal(
      matchByFolderOrTitle({ title: 'Amnesiac' }, candidates),
      undefined
    );
  });
});

describe('statuses', () => {
  it('follow Lidarr’s files when Lidarr decides', () => {
    assert.equal(lidarrStatus(10, 10), MediaStatus.AVAILABLE);
    assert.equal(lidarrStatus(10, 12), MediaStatus.AVAILABLE);
    assert.equal(lidarrStatus(10, 3), MediaStatus.PARTIALLY_AVAILABLE);
    assert.equal(lidarrStatus(10, 0), undefined);
    assert.equal(lidarrStatus(0, 0), undefined);
  });

  const { AVAILABLE, PARTIALLY_AVAILABLE, PROCESSING, PENDING, UNKNOWN } =
    MediaStatus;
  const album = (status: MediaStatus, wanted = false) => ({ status, wanted });

  it('make an artist available once every album wanted is here', () => {
    assert.equal(
      artistStatus(PROCESSING, [album(AVAILABLE, true), album(UNKNOWN)]),
      AVAILABLE
    );
    assert.equal(
      artistStatus(PROCESSING, [
        album(AVAILABLE, true),
        album(PROCESSING, true),
      ]),
      PARTIALLY_AVAILABLE
    );
    // Nothing wanted: some of their music is here, not all of it.
    assert.equal(
      artistStatus(UNKNOWN, [album(AVAILABLE)]),
      PARTIALLY_AVAILABLE
    );
    assert.equal(
      artistStatus(UNKNOWN, [album(PARTIALLY_AVAILABLE, true)]),
      PARTIALLY_AVAILABLE
    );
  });

  it('leave what requests say while nothing is here', () => {
    assert.equal(artistStatus(PENDING, [album(UNKNOWN, true)]), PENDING);
    assert.equal(artistStatus(PROCESSING, []), PROCESSING);
    assert.equal(artistStatus(UNKNOWN, [album(PROCESSING, true)]), PROCESSING);
    assert.equal(artistStatus(UNKNOWN, [album(UNKNOWN)]), UNKNOWN);
  });

  it('go down with their albums', () => {
    assert.equal(
      artistStatus(AVAILABLE, [album(MediaStatus.DELETED, true)]),
      MediaStatus.DELETED
    );
    assert.equal(artistStatus(PARTIALLY_AVAILABLE, [album(UNKNOWN)]), UNKNOWN);
    assert.equal(
      artistStatus(MediaStatus.BLOCKLISTED, [album(AVAILABLE, true)]),
      MediaStatus.BLOCKLISTED
    );
  });
});
