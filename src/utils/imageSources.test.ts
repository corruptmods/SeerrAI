import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sourcesFor } from './imageSources';

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
