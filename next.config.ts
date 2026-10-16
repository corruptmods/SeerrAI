import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  env: {
    commitTag: process.env.COMMIT_TAG || 'local',
  },
  // Pictures load from where they are (or through Seerr's own image cache),
  // never through Next's resizer: that would let anyone, signed in or not,
  // have the server fetch and keep pictures outside the image cache's limit.
  images: {
    unoptimized: true,
  },
  // Compression is done once, by the server, with brotli where the browser
  // accepts it (see server/index.ts). Next's own gzip stays off so a second,
  // weaker pass can never apply.
  compress: false,
  transpilePackages: ['country-flag-icons'],
  turbopack: {
    rules: {
      '*.svg': {
        loaders: ['@svgr/webpack'],
        as: '*.js',
      },
    },
  },
  experimental: {
    scrollRestoration: true,
    largePageDataBytes: 512 * 1000,
  },
  async headers() {
    return [
      {
        // The service worker must never be served from any cache — browser,
        // proxy or CDN. A cached copy means a phone keeps reinstalling an old
        // worker and can never pick up a fix to it.
        source: '/sw.js',
        headers: [
          {
            key: 'Cache-Control',
            value: 'no-cache, no-store, must-revalidate, max-age=0',
          },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ];
  },
};

export default nextConfig;
