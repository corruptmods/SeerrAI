import type { MusicSettings } from '@server/lib/settings';
import {
  MUSICBRAINZ_URL,
  getSettings,
  musicInAllSearch,
} from '@server/lib/settings';
import { requireMusicSettings } from '@server/middleware/music';
import { Router } from 'express';
import { z } from 'zod';

/*
 * Settings → Music: where music's details come from, and whether music
 * comes below the films and series in All, saved together. The TheAudioDB
 * key is never sent back; saving without one keeps the saved key, and only
 * `removeTheAudioDbApiKey` clears it. A save that leaves out `search`, or
 * the song settings, keeps them as they are. There before a Lidarr is
 * added, gone while music is off for everyone.
 */
const musicSettingsRoutes = Router();

musicSettingsRoutes.use(requireMusicSettings);

const musicBody = z.object({
  musicbrainzUrl: z
    .string()
    .trim()
    .default('')
    .refine((url) => !url || /^https?:\/\/[^\s/]+(?:\/\S*)?$/.test(url))
    .transform((url) => url.replace(/\/+$/, '') || MUSICBRAINZ_URL),
  contactEmail: z
    .string()
    .trim()
    .default('')
    .refine((email) => !email || z.email().safeParse(email).success),
  listenBrainz: z.boolean().default(true),
  theAudioDbApiKey: z.string().trim().default(''),
  removeTheAudioDbApiKey: z.boolean().default(false),
  maxAlbumsPerRequest: z.coerce.number().int().min(1).max(1000).default(100),
  songRequests: z.boolean().optional(),
  songsFromAlbums: z.boolean().optional(),
  songQuota: z
    .object({
      quotaLimit: z.coerce.number().int().min(0).max(1000),
      quotaDays: z.coerce.number().int().min(0).max(100),
    })
    .optional(),
  // Sent only when the admin changes it; anything else an older page
  // sends with it is left out.
  search: z.object({ inAll: z.boolean() }).optional(),
});

/** What the settings page is shown: no key, only that one is set. */
const shown = (music: MusicSettings) => ({
  musicbrainzUrl: music.musicbrainzUrl,
  contactEmail: music.contactEmail,
  listenBrainz: music.listenBrainz,
  maxAlbumsPerRequest: music.maxAlbumsPerRequest,
  songRequests: !!music.songRequests,
  songsFromAlbums: !!music.songsFromAlbums,
  songQuota: music.songQuota,
  hasTheAudioDbApiKey: !!music.theAudioDbApiKey,
  search: {
    inAll: musicInAllSearch(
      music.search,
      getSettings().lidarr.some((lidarr) => lidarr.isDefault)
    ),
  },
});

musicSettingsRoutes.get('/', (_req, res) => {
  res.status(200).json(shown(getSettings().music));
});

musicSettingsRoutes.post('/', async (req, res, next) => {
  const parsed = musicBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return next({ status: 400, message: 'Check the music settings.' });
  }
  const body = parsed.data;
  const settings = getSettings();
  const saved = settings.music;
  settings.music = {
    musicbrainzUrl: body.musicbrainzUrl,
    contactEmail: body.contactEmail,
    listenBrainz: body.listenBrainz,
    maxAlbumsPerRequest: body.maxAlbumsPerRequest,
    songRequests: body.songRequests ?? !!saved.songRequests,
    songsFromAlbums: body.songsFromAlbums ?? !!saved.songsFromAlbums,
    songQuota: body.songQuota ?? saved.songQuota,
    theAudioDbApiKey: body.removeTheAudioDbApiKey
      ? ''
      : body.theAudioDbApiKey || saved.theAudioDbApiKey,
    search: body.search ? { inAll: body.search.inAll } : saved.search,
  };
  await settings.save();
  return res.status(200).json(shown(settings.music));
});

export default musicSettingsRoutes;
