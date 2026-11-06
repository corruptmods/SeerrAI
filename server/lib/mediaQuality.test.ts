import { MediaStatus, MediaType } from '@server/constants/media';
import Media from '@server/entity/Media';
import {
  availableQuality,
  combineQuality,
  jellyfinSourceQuality,
  plexVersionQuality,
  radarrFileQuality,
  rangesFrom,
  recordQuality,
  resolutionFromPlex,
  resolutionOf,
} from '@server/lib/mediaQuality';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('the qualities a title is here in', () => {
  it('classes a frame size by width first, so scope crops keep their class', () => {
    assert.equal(resolutionOf(3840, 2160), '4K');
    assert.equal(resolutionOf(3840, 1600), '4K');
    assert.equal(resolutionOf(2560, 1440), '1440p');
    assert.equal(resolutionOf(1920, 800), '1080p');
    assert.equal(resolutionOf(1280, 534), '720p');
    assert.equal(resolutionOf(720, 576), 'SD');
    assert.equal(resolutionOf(undefined, 2160), '4K');
    assert.equal(resolutionOf(0, 0), undefined);
  });

  it('reads Plex’s resolution labels', () => {
    assert.equal(resolutionFromPlex('4k'), '4K');
    assert.equal(resolutionFromPlex('1080'), '1080p');
    assert.equal(resolutionFromPlex('sd'), 'SD');
    assert.equal(resolutionFromPlex('480'), 'SD');
    assert.equal(resolutionFromPlex(undefined), undefined);
  });

  it('reads HDR formats from Jellyfin, Emby and Radarr labels', () => {
    assert.deepEqual(rangesFrom('DOVIWithHDR10'), ['DV', 'HDR10']);
    assert.deepEqual(rangesFrom('HDR10Plus', 'HDR'), ['HDR10+']);
    assert.deepEqual(rangesFrom('HLG'), ['HLG']);
    assert.deepEqual(rangesFrom('DolbyVision', 'DoviProfile81'), ['DV']);
    assert.deepEqual(rangesFrom('HyperLogGamma'), ['HLG']);
    assert.deepEqual(rangesFrom('DV HDR10'), ['DV', 'HDR10']);
    assert.deepEqual(rangesFrom('PQ', 'HDR'), ['HDR']);
    assert.deepEqual(rangesFrom('SDR', 'SDR'), []);
    assert.deepEqual(rangesFrom('None'), []);
    assert.equal(rangesFrom(undefined, ''), undefined);
  });

  it('reads a Plex version, with HDR only when Plex sent its streams', () => {
    assert.deepEqual(
      plexVersionQuality({ width: 3840, height: 2160, videoResolution: '4k' }),
      { resolutions: ['4K'] }
    );
    assert.deepEqual(
      plexVersionQuality({
        videoResolution: '4k',
        Part: [
          {
            Stream: [
              { streamType: 2 },
              { streamType: 1, DOVIPresent: true, colorTrc: 'smpte2084' },
            ],
          },
        ],
      }),
      { resolutions: ['4K'], ranges: ['DV', 'HDR10'] }
    );
    assert.deepEqual(
      plexVersionQuality({
        videoResolution: '1080',
        Part: [{ Stream: [{ streamType: 1, colorTrc: 'bt709' }] }],
      }),
      { resolutions: ['1080p'], ranges: [] }
    );
    assert.equal(plexVersionQuality({}), undefined);
  });

  it('reads a Jellyfin or Emby version by its video stream', () => {
    assert.deepEqual(
      jellyfinSourceQuality({
        MediaStreams: [
          { Type: 'Audio' },
          {
            Type: 'Video',
            Width: 3840,
            Height: 2160,
            VideoRange: 'HDR',
            VideoRangeType: 'DOVIWithHDR10',
          },
        ],
      }),
      { resolutions: ['4K'], ranges: ['DV', 'HDR10'] }
    );
    assert.deepEqual(
      jellyfinSourceQuality({
        MediaStreams: [
          {
            Type: 'Video',
            Width: 1920,
            Height: 1080,
            ExtendedVideoType: 'None',
          },
        ],
      }),
      { resolutions: ['1080p'], ranges: [] }
    );
    assert.deepEqual(
      jellyfinSourceQuality({
        MediaStreams: [{ Type: 'Video', Width: 1280, Height: 720 }],
      }),
      { resolutions: ['720p'] }
    );
    assert.equal(jellyfinSourceQuality({ MediaStreams: [] }), undefined);
  });

  it('reads a Radarr file, whose media info always says SDR or HDR', () => {
    assert.deepEqual(
      radarrFileQuality({
        mediaInfo: {
          resolution: '3840x1606',
          videoDynamicRange: 'HDR',
          videoDynamicRangeType: 'DV HDR10',
        },
      }),
      { resolutions: ['4K'], ranges: ['DV', 'HDR10'] }
    );
    assert.deepEqual(
      radarrFileQuality({
        mediaInfo: {
          resolution: '1920x1080',
          videoDynamicRange: '',
          videoDynamicRangeType: '',
        },
      }),
      { resolutions: ['1080p'], ranges: [] }
    );
    assert.deepEqual(
      radarrFileQuality({ quality: { quality: { resolution: 720 } } }),
      { resolutions: ['720p'] }
    );
    assert.equal(radarrFileQuality(undefined), undefined);
  });

  it('combines versions, keeping HDR only from those that could tell', () => {
    assert.deepEqual(
      combineQuality([
        { resolutions: ['1080p'] },
        { resolutions: ['4K'], ranges: ['HDR10'] },
        undefined,
        { resolutions: ['1080p'], ranges: [] },
      ]),
      { resolutions: ['4K', '1080p'], ranges: ['HDR10'] }
    );
    assert.deepEqual(combineQuality([{ resolutions: ['720p'] }]), {
      resolutions: ['720p'],
    });
    assert.equal(combineQuality([undefined]), undefined);
  });

  it('records one source’s side, unchanged when it saw the same', () => {
    const first = recordQuality(null, 'plex', 'standard', {
      resolutions: ['1080p'],
    });
    assert.deepEqual(first, { plex: { standard: { resolutions: ['1080p'] } } });
    assert.equal(
      recordQuality(first, 'plex', 'standard', { resolutions: ['1080p'] }),
      first
    );
    assert.equal(recordQuality(first, 'plex', 'standard', undefined), first);

    const both = recordQuality(first, 'radarr', '4k', {
      resolutions: ['4K'],
      ranges: ['DV'],
    });
    assert.deepEqual(both, {
      plex: { standard: { resolutions: ['1080p'] } },
      radarr: { '4k': { resolutions: ['4K'], ranges: ['DV'] } },
    });
    assert.deepEqual(recordQuality(both, 'radarr', '4k', null), first);
    assert.equal(recordQuality(first, 'plex', 'standard', null), null);
  });

  it('shows what the servers still holding a title saw, with Radarr’s HDR for the same file', () => {
    const media = new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: 1,
      status: MediaStatus.AVAILABLE,
      ratingKey: 'rk-1',
      externalServiceId: 7,
      quality: {
        plex: { standard: { resolutions: ['4K'] } },
        jellyfin: { standard: { resolutions: ['1080p'], ranges: [] } },
        radarr: { standard: { resolutions: ['4K'], ranges: ['HDR10'] } },
      },
    });
    // Jellyfin no longer has it: its id was cleared.
    assert.deepEqual(availableQuality(media, 'standard'), {
      resolutions: ['4K'],
      ranges: ['HDR10'],
    });

    // Radarr's file differs from what Plex has: its HDR isn't Plex's.
    media.quality = {
      plex: { standard: { resolutions: ['1080p'] } },
      radarr: { standard: { resolutions: ['4K'], ranges: ['DV'] } },
    };
    assert.deepEqual(availableQuality(media, 'standard'), {
      resolutions: ['1080p'],
      ranges: [],
    });
  });

  it('falls back to Radarr, and shows nothing it doesn’t know', () => {
    const media = new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: 2,
      externalServiceId4k: 9,
      quality: {
        radarr: { '4k': { resolutions: ['4K'], ranges: ['DV', 'HDR10'] } },
      },
    });
    assert.deepEqual(availableQuality(media, '4k'), {
      resolutions: ['4K'],
      ranges: ['DV', 'HDR10'],
    });
    assert.equal(availableQuality(media, 'standard'), undefined);

    media.externalServiceId4k = null;
    assert.equal(availableQuality(media, '4k'), undefined);
  });

  it('is on a loaded title only while that side is available', () => {
    const media = new Media({
      mediaType: MediaType.TV,
      tmdbId: 3,
      status: MediaStatus.PARTIALLY_AVAILABLE,
      status4k: MediaStatus.DELETED,
      jellyfinMediaId: 'jf-3',
      jellyfinMediaId4k: 'jf-3',
      quality: {
        jellyfin: {
          standard: { resolutions: ['1080p', '720p'], ranges: [] },
          '4k': { resolutions: ['4K'], ranges: ['HDR10'] },
        },
      },
    });
    media.setAvailableQuality();
    assert.deepEqual(media.availableQuality, {
      resolutions: ['1080p', '720p'],
      ranges: [],
    });
    assert.equal(media.availableQuality4k, undefined);
  });
});
