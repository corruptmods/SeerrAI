import type { MusicSearchSettings, MusicSettings } from '@server/lib/settings';
import { MUSICBRAINZ_URL, getSettings } from '@server/lib/settings';
import { requireMusicSettings } from '@server/middleware/music';
import { Router } from 'express';
import { z } from 'zod';

/*
 * Settings → Metadata → Music: where music's details come from. The
 * TheAudioDB key is never sent back; saving without one keeps the saved
 * key, and only `removeTheAudioDbApiKey` clears it.
 *
 * /search is Settings → Music: where music can be searched and how much a
 * search shows. Like the rest, it is there before a Lidarr is added and
 * gone while music is off for everyone.
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
});

/** What the settings page is shown: no key, only that one is set. */
const shown = (music: MusicSettings) => ({
  musicbrainzUrl: music.musicbrainzUrl,
  contactEmail: music.contactEmail,
  listenBrainz: music.listenBrainz,
  maxAlbumsPerRequest: music.maxAlbumsPerRequest,
  hasTheAudioDbApiKey: !!music.theAudioDbApiKey,
});

/** The most artists, or albums, a search may be set to show. */
export const MOST_SEARCH_RESULTS = 25;

const searchCount = z.number().int().min(1).max(MOST_SEARCH_RESULTS);

/** Anything left out keeps what is saved. */
const searchBody = z.object({
  inAll: z.boolean().optional(),
  musicPage: z.boolean().optional(),
  chip: z.boolean().optional(),
  artists: searchCount.optional(),
  albums: searchCount.optional(),
});

musicSettingsRoutes.get('/search', (_req, res) => {
  res.status(200).json(getSettings().music.search);
});

musicSettingsRoutes.post('/search', async (req, res, next) => {
  const parsed = searchBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return next({ status: 400, message: 'Check the music search settings.' });
  }
  const settings = getSettings();
  const search: MusicSearchSettings = {
    ...settings.music.search,
    ...Object.fromEntries(
      Object.entries(parsed.data).filter(([, value]) => value !== undefined)
    ),
  };
  settings.music = { ...settings.music, search };
  await settings.save();
  return res.status(200).json(search);
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
    theAudioDbApiKey: body.removeTheAudioDbApiKey
      ? ''
      : body.theAudioDbApiKey || saved.theAudioDbApiKey,
    // Set from Settings → Music, not here.
    search: saved.search,
  };
  await settings.save();
  return res.status(200).json(shown(settings.music));
});

export default musicSettingsRoutes;
