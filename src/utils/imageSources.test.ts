import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  convertible,
  preloadFor,
  sourcesFor,
  titleBackdrop,
  titlePoster,
  tmdbImageSrc,
} from './imageSources';

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
    '/imageproxy/caa/release-group/7e41c0d8-5b29-3f6c-b8a4-91d6e2f07a35';

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
    const [avif] = sourcesFor('/imageproxy/artist/3c9e5f21/backdrop');
    assert.equal(avif.responsive, true);
    assert.match(avif.srcSet, /backdrop\?f=avif&w=480 480w/);
  });

  it('offer a picture of an artist smaller too, for the tiles it fills', () => {
    // fanart.tv's are 1000 square; a tile is a few hundred pixels wide.
    const [photo] = sourcesFor('/imageproxy/artist/3c9e5f21');
    assert.equal(photo.responsive, true);
    assert.equal(
      photo.srcSet,
      [
        '/imageproxy/artist/3c9e5f21?f=avif&w=480 480w',
        '/imageproxy/artist/3c9e5f21?f=avif&w=780 780w',
        '/imageproxy/artist/3c9e5f21?f=avif 1000w',
      ].join(', ')
    );
  });
});

describe('convertible', () => {
  it('is what the proxy can convert: its JPEGs and PNGs, covers and artists', () => {
    for (const url of [
      '/imageproxy/tmdb/t/p/w300_and_h450_face/a.jpg',
      '/imageproxy/tvdb/banners/a.png',
      '/imageproxy/caa/release-group/7e41c0d8-5b29-3f6c-b8a4-91d6e2f07a35/front-500',
      '/imageproxy/fanart/fanart/music/x/artistthumb/a.jpg',
      '/imageproxy/artist/3c9e5f21-8d47-4b6a-a1e3-5f7d2c90b844',
      '/imageproxy/artist/3c9e5f21-8d47-4b6a-a1e3-5f7d2c90b844/backdrop',
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

describe('tmdbImageSrc', () => {
  it('goes through the image cache when it is on', () => {
    assert.equal(
      tmdbImageSrc('https://image.tmdb.org/t/p/w300_and_h450_face/a.jpg', true),
      '/imageproxy/tmdb/t/p/w300_and_h450_face/a.jpg'
    );
  });

  it('goes to TMDB when it is off, and leaves the app’s own pictures', () => {
    assert.equal(
      tmdbImageSrc(
        'https://image.tmdb.org/t/p/w300_and_h450_face/a.jpg',
        false
      ),
      'https://image.tmdb.org/t/p/w300_and_h450_face/a.jpg'
    );
    assert.equal(
      tmdbImageSrc('/images/seerr_poster_not_found.png', true),
      '/images/seerr_poster_not_found.png'
    );
  });
});

describe('the pictures at the top of a title’s page', () => {
  it('are at the addresses the page has always used, so kept copies count', () => {
    assert.equal(
      titleBackdrop('/b.jpg'),
      'https://image.tmdb.org/t/p/w1920_and_h800_multi_faces//b.jpg'
    );
    assert.equal(
      titlePoster('/p.jpg'),
      'https://image.tmdb.org/t/p/w600_and_h900_bestv2/p.jpg'
    );
  });
});

describe('preloadFor', () => {
  it('fetches a backdrop ahead in the width its <picture> will pick', () => {
    const url = tmdbImageSrc(titleBackdrop('/b.jpg'), true);
    const [avif] = sourcesFor(url);
    assert.deepEqual(preloadFor(url), {
      type: 'image/avif',
      imageSrcset: avif.srcSet,
      imageSizes: '100vw',
    });
  });

  it('fetches a poster ahead as the AVIF copy only', () => {
    const url = tmdbImageSrc(titlePoster('/p.jpg'), true);
    assert.deepEqual(preloadFor(url), {
      type: 'image/avif',
      href: '/imageproxy/tmdb/t/p/w600_and_h900_bestv2/p.jpg?f=avif',
    });
  });

  it('fetches a picture from TMDB as it is, with the image cache off', () => {
    const url = tmdbImageSrc(titlePoster('/p.jpg'), false);
    assert.deepEqual(preloadFor(url), { href: url });
  });
});
