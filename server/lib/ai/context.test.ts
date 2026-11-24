import { mergeNewestFirst } from '@server/lib/ai/context';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const server = (name: string, at?: number) => ({
  name,
  ...(at ? { at } : {}),
  from: 'server' as const,
});
const trakt = (name: string, at: number) => ({
  name,
  at,
  from: 'trakt' as const,
});

describe('merging server and Trakt watching', () => {
  it('puts the newest first', () => {
    assert.deepEqual(
      mergeNewestFirst(
        [server('Static Garden', 50), server('Lantern Song', 10)],
        [trakt('Glasswing', 30), trakt('Harbour Lights', 60)]
      ).map((item) => item.name),
      ['Harbour Lights', 'Static Garden', 'Glasswing', 'Lantern Song']
    );
  });

  it('keeps undated server plays in the server’s order', () => {
    assert.deepEqual(
      mergeNewestFirst(
        [server('Static Garden'), server('Lantern Song')],
        [trakt('Glasswing', 30), trakt('Harbour Lights', 60)]
      ).map((item) => item.name),
      ['Static Garden', 'Lantern Song', 'Harbour Lights', 'Glasswing']
    );
  });
});
