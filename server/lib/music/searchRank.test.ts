import type {
  MbArtist,
  MbReleaseGroup,
} from '@server/api/musicbrainz/interfaces';
import {
  rankAlbums,
  rankArtists,
  searchWhileTied,
} from '@server/lib/music/searchRank';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * Which albums and artists a music search shows first. MusicBrainz scores
 * every exact match the same, so among those the most released album, then
 * the album over the single, comes first.
 */

const group = (
  id: string,
  {
    score = 100,
    count,
    type = 'Album',
    statuses,
    artists = [],
  }: {
    score?: number;
    count?: number;
    type?: string | null;
    statuses?: (string | null)[];
    artists?: string[];
  } = {}
): MbReleaseGroup => ({
  id,
  title: 'Moonlurker',
  score,
  count,
  'primary-type': type,
  releases: statuses?.map((status, i) => ({
    id: `${id}-${i}`,
    title: 'Moonlurker',
    status,
  })),
  'artist-credit': artists.map((artist) => ({
    name: artist,
    artist: { id: artist, name: artist },
  })),
});

const ids = (list: { id: string }[]) => list.map((item) => item.id);

describe('albums', () => {
  it('go by score first, however often a weaker match was released', () => {
    assert.deepEqual(
      ids(
        rankAlbums(
          [group('close', { score: 90, count: 500 }), group('exact')],
          12
        )
      ),
      ['exact', 'close']
    );
  });

  it('among equal scores, go by how many releases they have', () => {
    assert.deepEqual(
      ids(
        rankAlbums(
          [
            group('small', { count: 2 }),
            group('famous', { count: 312 }),
            group('middling', { count: 9 }),
          ],
          12
        )
      ),
      ['famous', 'middling', 'small']
    );
  });

  it('count the releases listed when MusicBrainz gives no count', () => {
    assert.deepEqual(
      ids(
        rankAlbums(
          [
            group('one', { statuses: ['Official'] }),
            group('three', { statuses: ['Official', 'Official', null] }),
          ],
          12
        )
      ),
      ['three', 'one']
    );
  });

  it('then put albums before EPs, singles and everything else', () => {
    assert.deepEqual(
      ids(
        rankAlbums(
          [
            group('other', { count: 1, type: 'Other' }),
            group('none', { count: 1, type: null }),
            group('single', { count: 1, type: 'Single' }),
            group('ep', { count: 1, type: 'EP' }),
            group('album', { count: 1, type: 'Album' }),
          ],
          12
        )
      ),
      ['album', 'ep', 'single', 'other', 'none']
    );
  });

  it('then put bootleg-only albums after the rest', () => {
    assert.deepEqual(
      ids(
        rankAlbums(
          [
            group('bootleg', { statuses: ['Bootleg', 'Bootleg'] }),
            group('unknown', { statuses: [null, null] }),
            group('official', { statuses: ['Bootleg', 'Official'] }),
          ],
          12
        )
      ),
      ['unknown', 'official', 'bootleg']
    );
  });

  it('keep MusicBrainz’s order when nothing tells them apart', () => {
    const tied = ['a', 'b', 'c', 'd', 'e'].map((id) => group(id, { count: 1 }));
    assert.deepEqual(ids(rankAlbums(tied, 12)), ['a', 'b', 'c', 'd', 'e']);
  });

  it('are cut to the number shown, after ranking', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      group(`g${i}`, { count: 1 })
    );
    many.push(group('famous', { count: 300 }));
    const shown = rankAlbums(many, 12);
    assert.equal(shown.length, 12);
    assert.equal(shown[0].id, 'famous');
    assert.deepEqual(ids(shown.slice(1)), ids(many.slice(0, 11)));
  });

  it('leave what they were given alone', () => {
    const given = [group('a', { count: 1 }), group('b', { count: 5 })];
    rankAlbums(given, 12);
    assert.deepEqual(ids(given), ['a', 'b']);
  });
});

describe('artists', () => {
  const artist = (
    id: string,
    { score = 100, tags }: { score?: number; tags?: number[] } = {}
  ): MbArtist => ({
    id,
    name: id,
    score,
    tags: tags?.map((count, i) => ({ name: `tag ${i}`, count })),
  });

  it('go by score first', () => {
    assert.deepEqual(
      ids(
        rankArtists(
          [artist('close', { score: 80 }), artist('exact')],
          [group('x', { artists: ['close'] })],
          8
        )
      ),
      ['exact', 'close']
    );
  });

  it('then put the artists of the albums shown first, in that order', () => {
    const albums = [
      group('top', { artists: ['second-credit', 'band'] }),
      group('next', { artists: ['other-band'] }),
    ];
    assert.deepEqual(
      ids(
        rankArtists(
          [
            artist('stranger'),
            artist('other-band'),
            artist('band'),
            artist('second-credit'),
          ],
          albums,
          8
        )
      ),
      ['band', 'second-credit', 'other-band', 'stranger']
    );
  });

  it('then the ones people have tagged most', () => {
    assert.deepEqual(
      ids(
        rankArtists(
          [
            artist('untagged'),
            artist('known', { tags: [4, 3, 2] }),
            artist('barely', { tags: [1] }),
          ],
          [],
          8
        )
      ),
      ['known', 'barely', 'untagged']
    );
  });

  it('keep MusicBrainz’s order otherwise, cut to the number shown', () => {
    const many = Array.from({ length: 25 }, (_, i) => artist(`a${i}`));
    assert.deepEqual(ids(rankArtists(many, [], 8)), ids(many.slice(0, 8)));
  });
});

describe('looking further when titles tie', () => {
  const PAGE = 4;
  /** A search with `total` results; scores as given, then 50. */
  const search = (scores: number[], total = 1000) => {
    const offsets: number[] = [];
    const page = async (offset: number) => {
      offsets.push(offset);
      return {
        count: total,
        items: Array.from(
          { length: Math.max(0, Math.min(PAGE, total - offset)) },
          (_, i) => ({ id: `r${offset + i}`, score: scores[offset + i] ?? 50 })
        ),
      };
    };
    return { page, offsets };
  };

  it('asks once when the first page ends below the top score', async () => {
    const { page, offsets } = search([100, 100, 100, 80]);
    const found = await searchWhileTied(page, { pageSize: PAGE, maxPages: 3 });
    assert.deepEqual(offsets, [0]);
    assert.equal(found.length, 4);
  });

  it('asks for the next page while the last one is still tied', async () => {
    const { page, offsets } = search([100, 100, 100, 100, 100, 100, 90, 90]);
    const found = await searchWhileTied(page, { pageSize: PAGE, maxPages: 3 });
    assert.deepEqual(offsets, [0, 4]);
    assert.deepEqual(ids(found), [
      'r0',
      'r1',
      'r2',
      'r3',
      'r4',
      'r5',
      'r6',
      'r7',
    ]);
  });

  it('stops after the most pages allowed', async () => {
    const { page, offsets } = search(Array(20).fill(100));
    const found = await searchWhileTied(page, { pageSize: PAGE, maxPages: 3 });
    assert.deepEqual(offsets, [0, 4, 8]);
    assert.equal(found.length, 12);
  });

  it('stops when there are no more results', async () => {
    const { page, offsets } = search(Array(20).fill(100), 4);
    await searchWhileTied(page, { pageSize: PAGE, maxPages: 3 });
    assert.deepEqual(offsets, [0]);

    const short = search(Array(20).fill(100), 6);
    const found = await searchWhileTied(short.page, {
      pageSize: PAGE,
      maxPages: 3,
    });
    assert.deepEqual(short.offsets, [0, 4]);
    assert.equal(found.length, 6);
  });

  it('keeps what it has when a further page fails', async () => {
    let asked = 0;
    const found = await searchWhileTied(
      async () => {
        if (asked++) {
          throw new Error('busy');
        }
        return {
          count: 100,
          items: [1, 2, 3, 4].map((n) => ({ id: `r${n}`, score: 100 })),
        };
      },
      { pageSize: PAGE, maxPages: 3 }
    );
    assert.equal(asked, 2);
    assert.equal(found.length, 4);
  });

  it('fails when the first page does', async () => {
    await assert.rejects(
      searchWhileTied(
        async () => {
          throw new Error('busy');
        },
        { pageSize: PAGE, maxPages: 3 }
      ),
      /busy/
    );
  });

  it('shows a result once when pages overlap', async () => {
    const pages = [
      ['a', 'b', 'c', 'd'],
      ['d', 'e', 'f', 'g'],
    ];
    const found = await searchWhileTied(
      async (offset) => ({
        count: 8,
        items: pages[offset / PAGE].map((id) => ({ id, score: 100 })),
      }),
      { pageSize: PAGE, maxPages: 2 }
    );
    assert.deepEqual(ids(found), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });
});
