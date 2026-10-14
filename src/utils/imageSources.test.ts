import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { convertible, sourcesFor } from './imageSources';

describe('sourcesFor', () => {
  it('offers a poster as AVIF, then WebP, at its own size', () => {
    assert.deepEqual(
      sourcesFor('/imageproxy/tmdb/t/p/w300_and_h450_face/a.jpg'),
      [
        {
          type: 'image/avif',
          srcSet: '/imageproxy/tmdb/t/p/w300_and_h450_face/a.jpg?f=avif',
          responsive: false,
        },
        {
          type: 'image/webp',
          srcSet: '/imageproxy/tmdb/t/p/w300_and_h450_face/a.jpg?f=webp',
          responsive: false,
        },
      ]
    );
  });

  it('offers a backdrop in smaller widths too, never wider than it is', () => {
    const [avif] = sourcesFor(
      '/imageproxy/tmdb/t/p/w1920_and_h800_multi_faces/b.jpg'
    );
    assert.equal(
      avif.srcSet,
      [
        '/imageproxy/tmdb/t/p/w1920_and_h800_multi_faces/b.jpg?f=avif&w=480 480w',
        '/imageproxy/tmdb/t/p/w1920_and_h800_multi_faces/b.jpg?f=avif&w=780 780w',
        '/imageproxy/tmdb/t/p/w1920_and_h800_multi_faces/b.jpg?f=avif&w=1280 1280w',
        '/imageproxy/tmdb/t/p/w1920_and_h800_multi_faces/b.jpg?f=avif 1920w',
      ].join(', ')
    );
    assert.equal(avif.responsive, true);

    const [smaller] = sourcesFor('/imageproxy/tmdb/t/p/w1280/c.jpg');
    assert.equal(
      smaller.srcSet,
      [
        '/imageproxy/tmdb/t/p/w1280/c.jpg?f=avif&w=480 480w',
        '/imageproxy/tmdb/t/p/w1280/c.jpg?f=avif&w=780 780w',
        '/imageproxy/tmdb/t/p/w1280/c.jpg?f=avif 1280w',
      ].join(', ')
    );
  });

  it('keeps a filtered address, commas and all, as one candidate', () => {
    const [avif] = sourcesFor(
      '/imageproxy/tmdb/t/p/w780_filter(duotone,ffffff,bababa)/d.jpg'
    );
    assert.equal(
      avif.srcSet,
      '/imageproxy/tmdb/t/p/w780_filter(duotone,ffffff,bababa)/d.jpg?f=avif'
    );
  });

  it('offers a TVDB picture, whose width is unknown, at its own size', () => {
    const [avif] = sourcesFor('/imageproxy/tvdb/banners/v4/series/1/a.jpg');
    assert.deepEqual(
      [avif.srcSet, avif.responsive],
      ['/imageproxy/tvdb/banners/v4/series/1/a.jpg?f=avif', false]
    );
  });
});

describe('music’s pictures', () => {
  const COVER =
    '/imageproxy/caa/release-group/b1392450-e666-3926-a536-22c65f834433';

  it('offer a cover as AVIF and WebP, though its address has no file name', () => {
    assert.deepEqual(
      sourcesFor(`${COVER}/front-500`).map((source) => source.srcSet),
      [`${COVER}/front-500?f=avif`, `${COVER}/front-500?f=webp`]
    );
  });

  it('offer a large cover in smaller widths too', () => {
    const [avif] = sourcesFor(`${COVER}/front-1200`);
    assert.equal(
      avif.srcSet,
      [
        `${COVER}/front-1200?f=avif&w=480 480w`,
        `${COVER}/front-1200?f=avif&w=780 780w`,
        `${COVER}/front-1200?f=avif 1200w`,
      ].join(', ')
    );
  });

  it('offer an artist’s backdrop in widths for each screen', () => {
    const [avif] = sourcesFor('/imageproxy/artist/a74b1b7f/backdrop');
    assert.equal(avif.responsive, true);
    assert.match(avif.srcSet, /backdrop\?f=avif&w=480 480w/);
    // Its photo is shown small.
    const [photo] = sourcesFor('/imageproxy/artist/a74b1b7f');
    assert.equal(photo.srcSet, '/imageproxy/artist/a74b1b7f?f=avif');
  });
});

describe('convertible', () => {
  it('is what the proxy can convert: its JPEGs and PNGs, covers and artists', () => {
    for (const url of [
      '/imageproxy/tmdb/t/p/w300_and_h450_face/a.jpg',
      '/imageproxy/tvdb/banners/a.png',
      '/imageproxy/caa/release-group/b1392450-e666-3926-a536-22c65f834433/front-500',
      '/imageproxy/fanart/fanart/music/x/artistthumb/a.jpg',
      '/imageproxy/artist/a74b1b7f-71a5-4011-9441-d0b5e4122711',
      '/imageproxy/artist/a74b1b7f-71a5-4011-9441-d0b5e4122711/backdrop',
    ]) {
      assert.equal(convertible(url), true, url);
    }
    for (const url of [
      '/imageproxy/tmdb/t/p/w154/logo.svg',
      'https://image.tmdb.org/t/p/w300/a.jpg',
      'https://coverartarchive.org/release-group/x/front-500',
      '/api/v1/music/artist/x/image',
      '/images/seerr_poster_not_found.png',
    ]) {
      assert.equal(convertible(url), false, url);
    }
  });
});
