import {
  PERSONAL_CSS_MAX_BYTES,
  SERVER_CSS_MAX_BYTES,
  checkPersonalCss,
  checkServerCss,
  cssAddresses,
} from '@server/constants/customCss';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * Custom CSS. An admin's Server CSS is trusted and may bring in stylesheets
 * from elsewhere; a person's own CSS may only use pictures and fonts from
 * this server, so a style pasted from somewhere can't send anything away.
 */

const problemOf = (css: unknown) => {
  const result = checkPersonalCss(css);
  return 'css' in result ? undefined : result;
};

describe('a person’s own CSS', () => {
  it('is kept as written when it only styles the page', () => {
    const css = `/* Squarer posters, just for me */
[data-seerr="title-card"] {
  border-radius: 4px;
  background: url(/imageproxy/tmdb/t/p/w300/abc.jpg) center / cover;
}
@font-face { font-family: Mine; src: url('/fonts/mine.woff2') format('woff2'), local(Arial); }
[data-seerr="button"]::after { content: "\\201C url(https://x) \\""; }
svg { filter: url(#glow); mask: url("data:image/svg+xml;utf8,<svg/>"); }
`;
    assert.deepEqual(checkPersonalCss(css), { css: css.trim() });
  });

  it('is empty when there is nothing but space', () => {
    assert.deepEqual(checkPersonalCss('  \n '), { css: '' });
  });

  it('may not bring in other stylesheets, however it is written', () => {
    for (const css of [
      '@import url(/other.css);',
      '@IMPORT "https://evil.example/x.css";',
      '@\\69mport "x.css";',
      '@im\\port "x.css";',
      '/* a */ @import/**/"x.css";',
    ]) {
      assert.deepEqual(problemOf(css), { problem: 'import' }, css);
    }
  });

  it('may only use pictures and fonts from this server', () => {
    for (const [css, address] of [
      [
        'a{background:url(https://evil.example/?q=1)}',
        'https://evil.example/?q=1',
      ],
      ['a{background:URL( "//evil.example/x" )}', '//evil.example/x'],
      ["a{background:url('/\\\\evil.example/x')}", '/\\evil.example/x'],
      ['a{background:u\\72l(http://evil.example)}', 'http://evil.example'],
      ['a{background:\\75 rl(http://evil.example)}', 'http://evil.example'],
      ['a{background:url(evil.example/x.png)}', 'evil.example/x.png'],
      ['a{background:url(https:evil.example)}', 'https:evil.example'],
      ['a{background:url("/\\9/evil.example")}', '/\t/evil.example'],
      ['a{background:url(data:text/html,hi)}', 'data:text/html,hi'],
      [
        '@font-face{src:src("https://evil.example/f.woff")}',
        'https://evil.example/f.woff',
      ],
      ['a{cursor:url(javascript:alert(1))}', 'javascript:alert(1'],
    ]) {
      assert.deepEqual(
        problemOf(css),
        { problem: 'url', detail: address },
        css
      );
    }
    assert.deepEqual(
      problemOf('a{background:image-set("https://evil.example/x.png" 1x)}'),
      { problem: 'url', detail: 'image-set()' }
    );
  });

  it('may not run anything', () => {
    for (const [css, detail] of [
      ['a{width:expression(alert(1))}', 'expression()'],
      ['a{width:EXPRESSION (alert(1))}', 'expression()'],
      ['a{behavior:url(/x.htc)}', 'behavior'],
      ['a{-ms-behavior:url(/x.htc)}', 'behavior'],
      ['a{-moz-binding:url(/x.xml#x)}', '-moz-binding'],
      ['a{-moz-b\\69nding:url(/x.xml#x)}', '-moz-binding'],
      ['a{content:"javascript:alert(1)"}', 'javascript:'],
      ['a{content:"vbscript:x"}', 'vbscript:'],
    ]) {
      assert.deepEqual(problemOf(css), { problem: 'script', detail }, css);
    }
  });

  it('has a size limit, counted in bytes', () => {
    assert.deepEqual(problemOf('a{}'.padEnd(PERSONAL_CSS_MAX_BYTES + 1)), {
      problem: 'tooLarge',
    });
    assert.deepEqual(
      problemOf(`a{content:"${'é'.repeat(PERSONAL_CSS_MAX_BYTES / 2)}"}`),
      { problem: 'tooLarge' }
    );
  });

  it('is text', () => {
    assert.deepEqual(problemOf(12), { problem: 'notText' });
    assert.deepEqual(problemOf({ css: 'a{}' }), { problem: 'notText' });
  });

  it('does not trip over comments and strings that only look like things', () => {
    const css = `a::before { content: "/* not a comment */"; }
/* url(https://evil.example) @import "x.css"; */
b { font-family: "url(https://x)", 'expression(' ; }
.behavior:hover, .no-expression { color: red; }`;
    assert.deepEqual(checkPersonalCss(css), { css });
  });
});

describe('the server’s CSS', () => {
  it('may bring in stylesheets from anywhere, such as theme.park', () => {
    const css =
      '@import url("https://theme-park.dev/css/base/overseerr/nord.css");\n[data-seerr="button"] { border-radius: 999px; }';
    assert.deepEqual(checkServerCss(css), { css });
  });

  it('has a size limit, and is text', () => {
    assert.deepEqual(checkServerCss('a{}'.padEnd(SERVER_CSS_MAX_BYTES + 1)), {
      problem: 'tooLarge',
    });
    assert.deepEqual(checkServerCss(null), { problem: 'notText' });
    assert.deepEqual(checkServerCss(''), { css: '' });
  });

  it('names the addresses it uses, imports apart', () => {
    assert.deepEqual(
      cssAddresses(`@import url("https://theme-park.dev/a.css");
@import 'https://cdn.example/b.css' screen;
/* @import "https://commented.example/c.css"; */
@font-face { src: url(https://fonts.example/f.woff2); }
a { background: url(/local.png); content: "url(https://in-a-string.example)"; }`),
      {
        imports: ['https://theme-park.dev/a.css', 'https://cdn.example/b.css'],
        others: ['https://fonts.example/f.woff2', '/local.png'],
      }
    );
  });
});
