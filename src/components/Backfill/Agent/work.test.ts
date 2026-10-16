import { TOOLS } from '@server/lib/agent/tools';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { changeIcon, changeWords, matchActions, toolWords } from './work';

describe("the agent's work in plain words", () => {
  it('has words for every tool it can use', () => {
    for (const tool of TOOLS) {
      assert.notEqual(
        toolWords(tool.name),
        'other',
        `${tool.name} has no plain words`
      );
    }
  });

  it('says "did something else" for a tool it does not know', () => {
    assert.equal(toolWords('a_new_tool'), 'other');
    assert.equal(toolWords(undefined), 'other');
    assert.equal(toolWords('toString'), 'other');
  });
});

describe('a change it made', () => {
  it('is shown with an icon for its kind', () => {
    assert.equal(changeIcon({ type: 'grab' }), 'download');
    assert.equal(changeIcon({ type: 'request' }), 'request');
    assert.equal(changeIcon({ type: 'stop' }), 'stop');
    assert.equal(changeIcon({ type: 'relink' }), 'link');
    // A delete was shown with a download arrow.
    assert.equal(
      changeIcon({ type: 'change', change: 'deleteFiles' }),
      'delete'
    );
    assert.equal(changeIcon({ type: 'change', change: 'blockGroup' }), 'block');
    assert.equal(
      changeIcon({ type: 'change', change: 'unblockGroup' }),
      'unblock'
    );
    assert.equal(
      changeIcon({ type: 'change', change: 'markFailed' }),
      'failed'
    );
    assert.equal(
      changeIcon({ type: 'change', change: 'changeProfile' }),
      'profile'
    );
    assert.equal(
      changeIcon({ type: 'change', change: 'somethingNew' }),
      'done'
    );
  });

  it('is named in a few words', () => {
    assert.equal(
      changeWords({ type: 'change', change: 'deleteFiles' }),
      'delete'
    );
    assert.equal(changeWords({ type: 'grab' }), 'download');
    assert.equal(
      changeWords({ type: 'grab', extended: true }),
      'addedToDownload'
    );
  });
});

describe('a change shown where it happened in the conversation', () => {
  const grab = { type: 'grab' as const, detail: '31 files (4.1 GB)' };
  const del = {
    type: 'change' as const,
    change: 'deleteFiles',
    detail: 'Delete the file of S01E52: deleted 1 file',
  };

  it('is matched to the change it records, by its words', () => {
    const take = matchActions([grab, del]);
    assert.equal(take(del.detail), del);
    assert.equal(take(grab.detail), grab);
  });

  it('matches two changes with the same words one each, in order', () => {
    const again = { ...grab };
    const take = matchActions([grab, again]);
    assert.equal(take(grab.detail), grab);
    assert.equal(take(grab.detail), again);
    assert.equal(take(grab.detail), undefined);
  });

  it('is left as it was written when no change matches', () => {
    assert.equal(matchActions([grab])('something older'), undefined);
  });
});
