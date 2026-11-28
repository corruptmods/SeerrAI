import { effortsFor, shownEffort } from '@server/constants/features';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('the efforts offered for a model', () => {
  it('offers Claude Low to High, and nothing for models before the 4 family', () => {
    assert.deepEqual(effortsFor('anthropic', '', 'claude-opus-5-5'), [
      'low',
      'medium',
      'high',
    ]);
    assert.deepEqual(effortsFor('anthropic', '', 'claude-sonnet-4-5'), [
      'low',
      'medium',
      'high',
    ]);
    assert.deepEqual(
      effortsFor('anthropic', '', 'claude-3-5-sonnet-latest'),
      []
    );
    assert.deepEqual(
      effortsFor('anthropic', '', 'claude-3-haiku-20240307'),
      []
    );
  });

  it('offers OpenAI’s own models what each family takes', () => {
    assert.deepEqual(effortsFor('openai', '', 'gpt-4o'), []);
    assert.deepEqual(effortsFor('openai', '', 'o3-mini'), [
      'low',
      'medium',
      'high',
    ]);
    assert.deepEqual(effortsFor('openai', '', 'gpt-5-mini'), [
      'lowest',
      'low',
      'medium',
      'high',
    ]);
    for (const model of ['gpt-5.1', 'gpt-6-luna']) {
      assert.deepEqual(
        effortsFor('openai', 'https://api.openai.com/v1/', model),
        ['none', 'low', 'medium', 'high']
      );
    }
  });

  it('offers every effort for another server, or before a model is chosen', () => {
    assert.equal(
      effortsFor('openai', 'http://nas.local:11434/v1', 'gpt-4o').length,
      5
    );
    assert.equal(effortsFor('openai', '', '').length, 5);
  });

  it('shows a saved effort as what it amounts to among those offered', () => {
    const claude = ['low', 'medium', 'high'] as const;
    assert.equal(shownEffort('lowest', claude), 'low');
    assert.equal(shownEffort('none', claude), 'low');
    assert.equal(shownEffort('medium', claude), 'medium');
    assert.equal(
      shownEffort('lowest', ['none', 'low', 'medium', 'high']),
      'none'
    );
    assert.equal(shownEffort('high', ['none', 'low']), 'low');
    assert.equal(shownEffort('high', []), undefined);
  });
});
