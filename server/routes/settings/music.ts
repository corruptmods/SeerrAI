import SlskdAPI, { slskdNewEnough } from '@server/api/slskd';
import { defaultLidarr, lidarrApi } from '@server/lib/music/access';
import { songPace } from '@server/lib/music/songPace';
import type { MusicSettings, SoulseekSettings } from '@server/lib/settings';
import {
  MUSICBRAINZ_URL,
  getSettings,
  musicInAllSearch,
} from '@server/lib/settings';
import logger from '@server/logger';
import { requireMusicSettings } from '@server/middleware/music';
import { isAxiosError } from 'axios';
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
  deezer: z.boolean().optional(),
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
  playlists: z
    .object({
      overLimit: z.enum(['wait', 'approve']),
      approveOver: z.coerce.number().int().min(1).max(1000),
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
  deezer: music.deezer !== false,
  maxAlbumsPerRequest: music.maxAlbumsPerRequest,
  songRequests: !!music.songRequests,
  songsFromAlbums: !!music.songsFromAlbums,
  songQuota: music.songQuota,
  playlists: music.playlists,
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
    deezer: body.deezer ?? saved.deezer !== false,
    maxAlbumsPerRequest: body.maxAlbumsPerRequest,
    songRequests: body.songRequests ?? !!saved.songRequests,
    songsFromAlbums: body.songsFromAlbums ?? !!saved.songsFromAlbums,
    songQuota: body.songQuota ?? saved.songQuota,
    playlists: body.playlists ?? saved.playlists,
    theAudioDbApiKey: body.removeTheAudioDbApiKey
      ? ''
      : body.theAudioDbApiKey || saved.theAudioDbApiKey,
    search: body.search ? { inAll: body.search.inAll } : saved.search,
    // Set apart, in Settings → Services.
    soulseek: saved.soulseek,
  };
  await settings.save();
  return res.status(200).json(shown(settings.music));
});

/*
 * Soulseek, through slskd (Settings → Services): its address, API key and
 * where its finished downloads are as Lidarr sees them. Saved only once
 * slskd answers, is new enough, and Lidarr sees that folder. The key is
 * never sent back; saving without one keeps the saved key, and a blank
 * address removes Soulseek.
 */
const soulseekBody = z.object({
  url: z
    .string()
    .trim()
    .default('')
    .refine((url) => !url || /^https?:\/\/[^\s/]+(?:\/\S*)?$/.test(url))
    .transform((url) => url.replace(/\/+$/, '')),
  apiKey: z.string().trim().default(''),
  downloadsPath: z
    .string()
    .trim()
    .default('')
    .refine((path) => !path || /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path))
    .transform((path) => path.replace(/(?<=.)[\\/]+$/, '')),
});

const soulseekShown = (soulseek: SoulseekSettings | undefined) => ({
  url: soulseek?.url ?? '',
  downloadsPath: soulseek?.downloadsPath ?? '',
  hasApiKey: !!soulseek?.apiKey,
});

class SoulseekProblem extends Error {}

/**
 * What slskd says of itself, once it answers with this key, is new enough
 * for downloads in batches, and Lidarr sees its downloads folder.
 */
const checkSoulseek = async (
  soulseek: SoulseekSettings
): Promise<{ version: string; signedIn: boolean }> => {
  let version: string;
  let signedIn: boolean;
  try {
    const app = await new SlskdAPI(soulseek).getApplication();
    version = app.version?.current ?? '';
    signedIn = !!app.server?.isLoggedIn;
  } catch (e) {
    const status = isAxiosError(e) ? e.response?.status : undefined;
    throw new SoulseekProblem(
      status === 401 || status === 403
        ? 'slskd turned the API key down.'
        : 'slskd didn’t answer at that address.'
    );
  }
  if (!slskdNewEnough(version)) {
    throw new SoulseekProblem(
      `slskd ${version || '(unknown)'} is too old: 0.26 or newer is needed.`
    );
  }
  const lidarr = defaultLidarr();
  if (lidarr && soulseek.downloadsPath) {
    const seen = await lidarrApi(lidarr)
      .folderExists(soulseek.downloadsPath)
      .catch((e) => {
        // Lidarr not answering says nothing of the folder.
        logger.debug('Could not ask Lidarr about slskd’s downloads folder', {
          label: 'Settings',
          errorMessage: e instanceof Error ? e.message : String(e),
        });
        return true;
      });
    if (!seen) {
      throw new SoulseekProblem(
        `Lidarr doesn’t see ${soulseek.downloadsPath}. Give Lidarr the folder slskd downloads to, and enter it as Lidarr sees it.`
      );
    }
  }
  return { version, signedIn };
};

/** The key typed, or the saved one when none is. */
const withKey = (body: z.infer<typeof soulseekBody>): SoulseekSettings => ({
  ...body,
  apiKey: body.apiKey || getSettings().music.soulseek?.apiKey || '',
});

/** How fast songs move: each limit, and how much of it is in use. */
musicSettingsRoutes.get('/pace', async (_req, res, next) => {
  try {
    res.status(200).json(await songPace());
  } catch (e) {
    next({ status: 500, message: e.message });
  }
});

musicSettingsRoutes.get('/soulseek', (_req, res) => {
  res.status(200).json(soulseekShown(getSettings().music.soulseek));
});

musicSettingsRoutes.post('/soulseek/test', async (req, res, next) => {
  const parsed = soulseekBody.safeParse(req.body ?? {});
  if (!parsed.success || !parsed.data.url) {
    return next({ status: 400, message: 'Check slskd’s address.' });
  }
  try {
    return res.status(200).json(await checkSoulseek(withKey(parsed.data)));
  } catch (e) {
    return next({
      status: 400,
      message: e instanceof SoulseekProblem ? e.message : String(e),
    });
  }
});

musicSettingsRoutes.put('/soulseek', async (req, res, next) => {
  const parsed = soulseekBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return next({
      status: 400,
      message:
        'Check slskd’s address, and enter the downloads folder as a full path.',
    });
  }
  const settings = getSettings();
  if (!parsed.data.url) {
    settings.music = {
      ...settings.music,
      soulseek: { url: '', apiKey: '', downloadsPath: '' },
    };
    await settings.save();
    return res.status(200).json(soulseekShown(settings.music.soulseek));
  }
  const soulseek = withKey(parsed.data);
  if (!soulseek.apiKey) {
    return next({ status: 400, message: 'Enter slskd’s API key.' });
  }
  if (!soulseek.downloadsPath) {
    return next({
      status: 400,
      message: 'Enter where slskd’s downloads are, as Lidarr sees them.',
    });
  }
  try {
    await checkSoulseek(soulseek);
  } catch (e) {
    return next({
      status: 400,
      message: e instanceof SoulseekProblem ? e.message : String(e),
    });
  }
  settings.music = { ...settings.music, soulseek };
  await settings.save();
  return res.status(200).json(soulseekShown(soulseek));
});

export default musicSettingsRoutes;
