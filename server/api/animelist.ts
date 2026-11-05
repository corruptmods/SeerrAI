import logger from '@server/logger';
import axios from 'axios';
import fs, { promises as fsp } from 'fs';
import path from 'path';
import xml2js from 'xml2js';

const UPDATE_INTERVAL_MSEC = 24 * 3600 * 1000;
// Formerly https://raw.githubusercontent.com/ScudLee/anime-lists/master/anime-list.xml
const MAPPING_URL =
  'https://raw.githubusercontent.com/Anime-Lists/anime-lists/master/anime-list.xml';
const LOCAL_PATH = process.env.CONFIG_DIRECTORY
  ? `${process.env.CONFIG_DIRECTORY}/anime-list.xml`
  : path.join(__dirname, '../../config/anime-list.xml');

const mappingRegexp = new RegExp(/;[0-9]+-([0-9]+)/g);

// Community-maintained AniDB → TVDB/TMDB id mappings, as the Hama agent uses.
// https://github.com/Anime-Lists/anime-lists/

interface AnimeMapping {
  $: {
    anidbseason: string;
    tvdbseason: string;
  };
  _: string;
}

interface Anime {
  $: {
    anidbid: number;
    tvdbid?: string;
    defaulttvdbseason?: string;
    tmdbid?: number;
    imdbid?: string;
  };
  'mapping-list'?: {
    mapping: AnimeMapping[];
  }[];
}

interface AnimeList {
  'anime-list': {
    anime: Anime[];
  };
}

export interface AnidbItem {
  tvdbId?: number;
  tmdbId?: number;
  imdbId?: string;
  tvdbSeason?: number;
}

class AnimeListMapping {
  private syncing = false;

  private mapping: { [anidbId: number]: AnidbItem } = {};

  // Mapping file mtime when last loaded.
  private mappingModified: Date | null = null;

  // Each TVDB season 0 episode can map to a movie.
  private specials: { [tvdbId: number]: { [episode: number]: AnidbItem } } = {};

  public isLoaded = () => Object.keys(this.mapping).length !== 0;

  private loadFromFile = async () => {
    logger.info('Loading mapping file', { label: 'Anime-List Sync' });
    try {
      const mappingStat = await fsp.stat(LOCAL_PATH);
      const file = await fsp.readFile(LOCAL_PATH);
      const xml = (await xml2js.parseStringPromise(file)) as AnimeList;

      this.mapping = {};
      this.specials = {};
      for (const anime of xml['anime-list'].anime) {
        // tvdbid can be non-numeric, e.g. 'movie'.
        let tvdbId: number | undefined;
        if (anime.$.tvdbid && !isNaN(Number(anime.$.tvdbid))) {
          tvdbId = Number(anime.$.tvdbid);
        } else {
          tvdbId = undefined;
        }

        let imdbIds: (string | undefined)[];
        if (anime.$.imdbid) {
          // Multiple imdb entries map to different movies.
          imdbIds = anime.$.imdbid.split(',');
        } else {
          // No imdbid is fine; there will be a tmdbid.
          imdbIds = [undefined];
        }

        const tmdbId = anime.$.tmdbid ? Number(anime.$.tmdbid) : undefined;
        const anidbId = Number(anime.$.anidbid);
        this.mapping[anidbId] = {
          // Season 0 must be a movie/OVA, so ignore tvdbid.
          tvdbId: anime.$.defaulttvdbseason === '0' ? undefined : tvdbId,
          tmdbId: tmdbId,
          imdbId: imdbIds[0], // for one AniDB -> one IMDb movie mappings
          tvdbSeason: Number(anime.$.defaulttvdbseason),
        };

        if (tvdbId) {
          const mappingList = anime['mapping-list'];
          if (mappingList && mappingList.length != 0) {
            let imdbIndex = 0;
            for (const mapping of mappingList[0].mapping) {
              const text = mapping._;
              if (text && mapping.$.tvdbseason === '0') {
                let matches;
                while ((matches = mappingRegexp.exec(text)) !== null) {
                  const episode = Number(matches[1]);
                  if (!this.specials[tvdbId]) {
                    this.specials[tvdbId] = {};
                  }
                  // Map the next imdbid to this season 0 episode.
                  const imdbId =
                    imdbIndex > imdbIds.length ? undefined : imdbIds[imdbIndex];
                  if (tmdbId || imdbId) {
                    this.specials[tvdbId][episode] = {
                      tmdbId: tmdbId,
                      imdbId: imdbId,
                    };
                    imdbIndex++;
                  }
                }
              }
            }
          } else {
            // No mapping-list: map episodes 1, 2, 3… to movies, which need an
            // imdbId or tmdbId.
            const hasImdb = imdbIds.length > 1 || imdbIds[0] !== undefined;
            if ((hasImdb || tmdbId) && anime.$.defaulttvdbseason === '0') {
              if (!this.specials[tvdbId]) {
                this.specials[tvdbId] = {};
              }
              // Season 0 episodes are 1-based.
              for (let idx = 0; idx < imdbIds.length; idx++) {
                this.specials[tvdbId][idx + 1] = {
                  tmdbId: tmdbId,
                  imdbId: imdbIds[idx],
                };
              }
            }
          }
        }
      }
      this.mappingModified = mappingStat.mtime;
      logger.info(
        `Loaded ${
          Object.keys(this.mapping).length
        } AniDB items from mapping file`,
        { label: 'Anime-List Sync' }
      );
    } catch (e) {
      throw new Error(`Failed to load Anime-List mappings: ${e.message}`, {
        cause: e,
      });
    }
  };

  private downloadFile = async () => {
    logger.info('Downloading latest mapping file', {
      label: 'Anime-List Sync',
    });
    try {
      const response = await axios.get(MAPPING_URL, {
        responseType: 'stream',
      });
      await new Promise<void>((resolve, reject) => {
        const writer = fs.createWriteStream(LOCAL_PATH);
        writer.on('finish', resolve);
        writer.on('error', reject);
        response.data.pipe(writer);
      });
    } catch (e) {
      throw new Error(`Failed to download Anime-List mapping: ${e.message}`, {
        cause: e,
      });
    }
  };

  public sync = async () => {
    if (this.syncing) {
      return;
    }

    this.syncing = true;
    try {
      // Local file not expired yet.
      if (fs.existsSync(LOCAL_PATH)) {
        const now = new Date();
        const stat = await fsp.stat(LOCAL_PATH);
        if (now.getTime() - stat.mtime.getTime() < UPDATE_INTERVAL_MSEC) {
          // Load if not loaded, or reload if modified externally since.
          if (
            !this.isLoaded() ||
            (this.mappingModified &&
              stat.mtime.getTime() > this.mappingModified.getTime())
          ) {
            await this.loadFromFile();
          }
          return;
        }
      }
      await this.downloadFile();
      await this.loadFromFile();
    } finally {
      this.syncing = false;
    }
  };

  public getFromAnidbId = (anidbId: number): AnidbItem | undefined => {
    return this.mapping[anidbId];
  };

  public getSpecialEpisode = (
    tvdbId: number,
    episode: number
  ): AnidbItem | undefined => {
    const episodes = this.specials[tvdbId];
    return episodes ? episodes[episode] : undefined;
  };
}

const animeList = new AnimeListMapping();

export default animeList;
