import defineMessages from '@app/utils/defineMessages';
import type { PresetKey } from '@server/lib/quality/types';
import type { IntlShape } from 'react-intl';

/*
 * Names the Quality page, its preview and What it does share: presets,
 * Seerr AI's own formats, and server states.
 */

export const labelMessages = defineMessages(
  'components.Settings.SettingsQuality.labels',
  {
    sd: 'SD',
    p720: '720p',
    p1080: '1080p',
    p1080remux: '1080p Remux',
    p2160: '2160p',
    p2160remux: '2160p Remux',
    anime: 'Anime',
    repack: 'Repack or proper',
    hdr: 'HDR or Dolby Vision',
    x265: 'x265 at 1080p or below',
    upscaled: 'Upscaled',
    language: 'Wrong language',
    burnedIn: 'Burned-in subtitles',
    av1: 'AV1',
    dualAudio: 'Dual audio',
    multiEpisode: 'More than one episode',
    overSize: 'Over {gb} GB',
    blockedGroups: 'Release groups you blocked',
  }
);

const PRESET_MESSAGE: Record<PresetKey, keyof typeof labelMessages> = {
  sd: 'sd',
  '720p': 'p720',
  '1080p': 'p1080',
  '1080p-remux': 'p1080remux',
  '2160p': 'p2160',
  '2160p-remux': 'p2160remux',
  anime: 'anime',
};

export const presetLabel = (intl: IntlShape, preset: PresetKey) =>
  intl.formatMessage(labelMessages[PRESET_MESSAGE[preset]]);

const SEERR_FORMATS: Record<string, keyof typeof labelMessages> = {
  'seerr:repack': 'repack',
  'seerr:hdr': 'hdr',
  'seerr:x265-hd': 'x265',
  'seerr:upscaled': 'upscaled',
  'seerr:language': 'language',
  'seerr:burned-in': 'burnedIn',
  'seerr:av1': 'av1',
  'seerr:dual-audio': 'dualAudio',
  'seerr:multi-episode': 'multiEpisode',
  'blocked-groups': 'blockedGroups',
};

const PREFIX = 'Seerr AI · ';

/** A format as an admin reads it: Seerr AI's in their language. */
export const formatLabel = (intl: IntlShape, key: string, name: string) => {
  const size = /^seerr:size-(\d+)$/.exec(key);
  if (size) {
    return intl.formatMessage(labelMessages.overSize, { gb: Number(size[1]) });
  }
  const message = SEERR_FORMATS[key];
  if (message) return intl.formatMessage(labelMessages[message]);
  return name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name;
};

/** A Seerr AI profile's name, as an admin reads it. */
export const profileLabel = (intl: IntlShape, key: string, name: string) => {
  const preset = Object.keys(PRESET_MESSAGE).find((p) => p === key) as
    | PresetKey
    | undefined;
  return preset ? `Seerr AI · ${presetLabel(intl, preset)}` : name;
};
