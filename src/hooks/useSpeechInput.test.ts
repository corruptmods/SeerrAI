import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isHandheld, problemOf, transcriptOf } from './useSpeechInput';

const result = (transcript: string, isFinal: boolean) =>
  Object.assign([{ transcript }], { isFinal });

describe('speech input', () => {
  it('joins what has been heard, and is final only once all of it is', () => {
    assert.deepEqual(
      transcriptOf(
        Object.assign([result('nova ', true), result('rift', false)])
      ),
      { text: 'nova rift', final: false }
    );
    assert.deepEqual(
      transcriptOf(Object.assign([result(' the mazewright ', true)])),
      { text: 'the mazewright', final: true }
    );
  });

  it('says what went wrong in terms someone can act on', () => {
    assert.equal(problemOf('not-allowed'), 'blocked');
    assert.equal(problemOf('service-not-allowed'), 'unavailable');
    assert.equal(problemOf('no-speech'), 'noSpeech');
    assert.equal(problemOf('audio-capture'), 'noMicrophone');
    assert.equal(problemOf('network'), 'network');
  });

  it('stays quiet when listening was stopped on purpose', () => {
    assert.equal(problemOf('aborted'), undefined);
  });

  it('leaves the button off phones and tablets only', () => {
    const windows =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
    const mac =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
    const iphone =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
    const android =
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
    const firefox =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0';

    // A touchscreen laptop is still a computer.
    assert.equal(isHandheld({ userAgent: windows, maxTouchPoints: 10 }), false);
    assert.equal(isHandheld({ userAgent: mac, maxTouchPoints: 0 }), false);
    assert.equal(isHandheld({ userAgent: firefox }), false);
    assert.equal(isHandheld({ userAgent: iphone, maxTouchPoints: 5 }), true);
    assert.equal(isHandheld({ userAgent: android, maxTouchPoints: 5 }), true);
    // An iPad asks for the desktop site, so it says Macintosh, with touch.
    assert.equal(isHandheld({ userAgent: mac, maxTouchPoints: 5 }), true);
    assert.equal(
      isHandheld({ userAgent: windows, userAgentData: { mobile: true } }),
      true
    );
  });
});
