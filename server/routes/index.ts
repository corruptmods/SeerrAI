import GithubAPI from '@server/api/github';
import PushoverAPI from '@server/api/pushover';
import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieResult,
  TmdbTvResult,
} from '@server/api/themoviedb/interfaces';
import { PROJECT_DEV_BRANCH } from '@server/constants/project';
import { getRepository } from '@server/datasource';
import DiscoverSlider from '@server/entity/DiscoverSlider';
import type { StatusResponse } from '@server/interfaces/api/settingsInterfaces';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import deprecatedRoute from '@server/middleware/deprecation';
import { mapProductionCompany } from '@server/models/Movie';
import { mapNetwork } from '@server/models/Tv';
import { mapWatchProviderDetails } from '@server/models/common';
import agentRoutes from '@server/routes/agent';
import aiRoutes from '@server/routes/ai';
import backfillRoutes from '@server/routes/backfill';
import backfillStatusRoutes from '@server/routes/backfillStatus';
import listRoutes from '@server/routes/list';
import overrideRuleRoutes from '@server/routes/overrideRule';
import settingsRoutes from '@server/routes/settings';
import watchlistRoutes from '@server/routes/watchlist';
import {
  appDataPath,
  appDataPermissions,
  appDataStatus,
} from '@server/utils/appDataVolume';
import {
  devBuildStatus,
  getAppVersion,
  getCommitTag,
} from '@server/utils/appVersion';
import { releaseUpdateAvailable } from '@server/utils/releases';
import restartFlag from '@server/utils/restartFlag';
import { isPerson } from '@server/utils/typeHelpers';
import { Router } from 'express';
import authRoutes from './auth';
import blocklistRoutes from './blocklist';
import calendarRoutes from './calendar';
import collectionRoutes from './collection';
import discoverRoutes, { createTmdbWithRegionLanguage } from './discover';
import discoverMusicRoutes from './discoverMusic';
import issueRoutes from './issue';
import issueCommentRoutes from './issueComment';
import maintainerrRoutes from './maintainerr';
import mediaRoutes from './media';
import movieRoutes from './movie';
import musicRoutes from './music';
import personRoutes from './person';
import requestRoutes from './request';
import searchRoutes from './search';
import serviceRoutes from './service';
import styleRoutes from './style';
import subtitleRoutes from './subtitles';
import tvRoutes from './tv';
import user from './user';

const router = Router();

router.use(checkUser);

router.get<unknown, StatusResponse>('/status', async (req, res) => {
  const settings = getSettings();
  const currentVersion = getAppVersion();
  const commitTag = getCommitTag();

  const checkUpdate =
    req.query.checkUpdateAvailable !== undefined
      ? req.query.checkUpdateAvailable
      : settings.fullPublicSettings.versionCheck;
  let updateAvailable = false;
  let commitsBehind = 0;

  if (checkUpdate) {
    const githubApi = new GithubAPI();

    if (currentVersion.startsWith('develop-') && commitTag !== 'local') {
      const commits = await githubApi.getSeerrCommits({
        branch: PROJECT_DEV_BRANCH,
      });
      ({ updateAvailable, commitsBehind } = devBuildStatus(
        commits
          .filter((commit) => !commit.commit.message.includes('[skip ci]'))
          .map((commit) => commit.sha),
        commitTag
      ));
    } else if (commitTag !== 'local') {
      // A stable install is only offered stable releases, and only one
      // newer than the version it runs.
      updateAvailable = releaseUpdateAvailable(
        await githubApi.getSeerrReleases(),
        currentVersion
      );
    }
  }

  return res.status(200).json({
    version: getAppVersion(),
    commitTag: getCommitTag(),
    ...(checkUpdate && { updateAvailable, commitsBehind }),
    restartRequired: restartFlag.isSet(),
  });
});

router.get('/status/appdata', (_req, res) => {
  return res.status(200).json({
    appData: appDataStatus(),
    appDataPath: appDataPath(),
    appDataPermissions: appDataPermissions(),
  });
});

router.use('/user', isAuthenticated(), user);
router.get('/settings/public', async (req, res) => {
  const settings = getSettings();

  if (!(req.user?.settings?.notificationTypes.webpush ?? true)) {
    return res
      .status(200)
      .json({ ...settings.fullPublicSettings, enablePushRegistration: false });
  } else {
    return res.status(200).json(settings.fullPublicSettings);
  }
});
router.get('/settings/discover', isAuthenticated(), async (_req, res) => {
  const sliderRepository = getRepository(DiscoverSlider);

  const sliders = await sliderRepository.find({ order: { order: 'ASC' } });

  return res.json(sliders);
});
router.get(
  '/settings/notifications/pushover/sounds',
  isAuthenticated(),
  async (req, res, next) => {
    const pushoverApi = new PushoverAPI();

    try {
      if (!req.query.token) {
        throw new Error('Pushover application token missing from request');
      }

      const sounds = await pushoverApi.getSounds(req.query.token as string);
      res.status(200).json(sounds);
    } catch (e) {
      logger.debug('Something went wrong retrieving Pushover sounds', {
        label: 'API',
        errorMessage: e.message,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve Pushover sounds.',
      });
    }
  }
);
router.use('/settings', isAuthenticated(Permission.ADMIN), settingsRoutes);
router.use('/search', isAuthenticated(), searchRoutes);
// Before Discover's own routes, which it is part of.
router.use('/discover/music', isAuthenticated(), discoverMusicRoutes);
router.use('/discover', isAuthenticated(), discoverRoutes);
router.use('/request', isAuthenticated(), requestRoutes);
router.use('/watchlist', isAuthenticated(), watchlistRoutes);
router.use('/blocklist', isAuthenticated(), blocklistRoutes);
router.use(
  '/blacklist',
  isAuthenticated(),
  deprecatedRoute({
    oldPath: '/api/v1/blacklist',
    newPath: '/api/v1/blocklist',
    sunsetDate: '2026-06-01',
  }),
  blocklistRoutes
);
router.use('/movie', isAuthenticated(), movieRoutes);
router.use('/tv', isAuthenticated(), tvRoutes);
router.use('/music', isAuthenticated(), musicRoutes);
router.use('/media', isAuthenticated(), mediaRoutes);
router.use('/calendar', isAuthenticated(), calendarRoutes);
router.use('/person', isAuthenticated(), personRoutes);
router.use('/collection', isAuthenticated(), collectionRoutes);
router.use('/service', isAuthenticated(), serviceRoutes);
router.use('/issue', isAuthenticated(), issueRoutes);
router.use('/issueComment', isAuthenticated(), issueCommentRoutes);
router.use('/auth', authRoutes);
router.use('/style', styleRoutes);
// Signed-in only at the group, as every other group is. Each list route also
// checks for itself, but a future one that forgot would otherwise be public.
router.use('/list', isAuthenticated(), listRoutes);
router.use('/maintainerr', isAuthenticated(), maintainerrRoutes);
router.use('/subtitles', isAuthenticated(), subtitleRoutes);
router.use('/ai', isAuthenticated(), aiRoutes);
router.use('/backfill', isAuthenticated(Permission.ADMIN), backfillRoutes);
router.use('/agent', isAuthenticated(Permission.ADMIN), agentRoutes);
// What Backfill is doing about the titles someone asked for, for them.
router.use('/backfill-status', isAuthenticated(), backfillStatusRoutes);
// Mounted for any signed-in user: each rule-management route requires admin
// itself, and the advanced-request preview has its own permission check.
router.use('/overrideRule', isAuthenticated(), overrideRuleRoutes);

router.get('/regions', isAuthenticated(), async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const regions = await tmdb.getRegions();

    return res.status(200).json(regions);
  } catch (e) {
    logger.debug('Something went wrong retrieving regions', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve regions.',
    });
  }
});

router.get('/languages', isAuthenticated(), async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const languages = await tmdb.getLanguages();

    return res.status(200).json(languages);
  } catch (e) {
    logger.debug('Something went wrong retrieving languages', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve languages.',
    });
  }
});

router.get<{ id: string }>('/studio/:id', async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const studio = await tmdb.getStudio(Number(req.params.id));

    return res.status(200).json(mapProductionCompany(studio));
  } catch (e) {
    logger.debug('Something went wrong retrieving studio', {
      label: 'API',
      errorMessage: e.message,
      studioId: req.params.id,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve studio.',
    });
  }
});

router.get<{ id: string }>('/network/:id', async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const network = await tmdb.getNetwork(Number(req.params.id));

    return res.status(200).json(mapNetwork(network));
  } catch (e) {
    logger.debug('Something went wrong retrieving network', {
      label: 'API',
      errorMessage: e.message,
      networkId: req.params.id,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve network.',
    });
  }
});

router.get('/genres/movie', isAuthenticated(), async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const genres = await tmdb.getMovieGenres({
      language: (req.query.language as string) ?? req.locale,
    });

    return res.status(200).json(genres);
  } catch (e) {
    logger.debug('Something went wrong retrieving movie genres', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve movie genres.',
    });
  }
});

router.get('/genres/tv', isAuthenticated(), async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const genres = await tmdb.getTvGenres({
      language: (req.query.language as string) ?? req.locale,
    });

    return res.status(200).json(genres);
  } catch (e) {
    logger.debug('Something went wrong retrieving series genres', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve series genres.',
    });
  }
});

router.get('/backdrops', async (req, res, next) => {
  const tmdb = createTmdbWithRegionLanguage();

  try {
    const data = (
      await tmdb.getAllTrending({
        page: 1,
        timeWindow: 'week',
      })
    ).results.filter((result) => !isPerson(result)) as (
      | TmdbMovieResult
      | TmdbTvResult
    )[];

    return res
      .status(200)
      .json(
        data
          .map((result) => result.backdrop_path)
          .filter((backdropPath) => !!backdropPath)
      );
  } catch (e) {
    logger.debug('Something went wrong retrieving backdrops', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve backdrops.',
    });
  }
});

router.get('/keyword/:keywordId', async (req, res, next) => {
  const tmdb = createTmdbWithRegionLanguage();

  try {
    const result = await tmdb.getKeywordDetails({
      keywordId: Number(req.params.keywordId),
    });

    return res.status(200).json(result);
  } catch (e) {
    logger.debug('Something went wrong retrieving keyword data', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve keyword data.',
    });
  }
});

router.get('/watchproviders/regions', async (req, res, next) => {
  const tmdb = createTmdbWithRegionLanguage();

  try {
    const result = await tmdb.getAvailableWatchProviderRegions({});
    return res.status(200).json(result);
  } catch (e) {
    logger.debug('Something went wrong retrieving watch provider regions', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve watch provider regions.',
    });
  }
});

router.get('/watchproviders/movies', async (req, res, next) => {
  const tmdb = createTmdbWithRegionLanguage();

  try {
    const result = await tmdb.getMovieWatchProviders({
      watchRegion: req.query.watchRegion as string,
    });

    return res.status(200).json(mapWatchProviderDetails(result));
  } catch (e) {
    logger.debug('Something went wrong retrieving movie watch providers', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve movie watch providers.',
    });
  }
});

router.get('/watchproviders/tv', async (req, res, next) => {
  const tmdb = createTmdbWithRegionLanguage();

  try {
    const result = await tmdb.getTvWatchProviders({
      watchRegion: req.query.watchRegion as string,
    });

    return res.status(200).json(mapWatchProviderDetails(result));
  } catch (e) {
    logger.debug('Something went wrong retrieving tv watch providers', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve tv watch providers.',
    });
  }
});

router.get(
  '/certifications/movie',
  isAuthenticated(),
  async (req, res, next) => {
    const tmdb = new TheMovieDb();

    try {
      const certifications = await tmdb.getMovieCertifications();

      return res.status(200).json(certifications);
    } catch (e) {
      logger.error('Something went wrong retrieving movie certifications', {
        label: 'API',
        errorMessage: e.message,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve movie certifications.',
      });
    }
  }
);

router.get('/certifications/tv', isAuthenticated(), async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const certifications = await tmdb.getTvCertifications();

    return res.status(200).json(certifications);
  } catch (e) {
    logger.debug('Something went wrong retrieving TV certifications', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve TV certifications.',
    });
  }
});

router.get('/', (_req, res) => {
  return res.status(200).json({
    api: 'Seerr API',
    version: '1.0',
  });
});

export default router;
