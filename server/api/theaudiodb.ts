import ExternalAPI from '@server/api/externalapi';
import logger from '@server/logger';

/*
 * TheAudioDB, for artist pictures Lidarr has none of, looked up by the
 * artist's MusicBrainz id. Its free key works for that; a supporter's key,
 * entered in Settings → Music, is used instead when there is one. Answers
 * are kept a week (see artistImage), so it is asked little.
 */

export const THE_AUDIO_DB_URL = 'https://www.theaudiodb.com/api/v1/json';

/** TheAudioDB's public key, for anyone without one of their own. */
export const THE_AUDIO_DB_FREE_KEY = '123';

/**
 * Lookups a minute with the free key, kept well inside what TheAudioDB
 * allows it; past that the answer is "could not be asked", which is not
 * kept, so the next visit asks again.
 */
const FREE_PER_MINUTE = 20;
const freeAsked: number[] = [];

const freeTurn = (now = Date.now()): boolean => {
  while (freeAsked.length && now - freeAsked[0] >= 60_000) freeAsked.shift();
  if (freeAsked.length >= FREE_PER_MINUTE) return false;
  freeAsked.push(now);
  return true;
};

const TIMEOUT_MS = 10_000;

interface TadbArtist {
  idArtist: string;
  strArtist: string;
  strArtistThumb?: string | null;
  strArtistFanart?: string | null;
  strArtistWideThumb?: string | null;
}

interface TadbArtistResponse {
  artists: TadbArtist[] | null;
}

export interface ArtistPictures {
  /** A square picture of the artist. */
  thumb: string | null;
  /** A wide one, for behind the artist's page. */
  fanart: string | null;
}

class TheAudioDb extends ExternalAPI {
  constructor(private apiKey: string) {
    super(THE_AUDIO_DB_URL, {}, { timeout: TIMEOUT_MS });
  }

  /**
   * The artist's pictures, none when it is not known; null when TheAudioDB
   * could not be asked, which says nothing of whether it has any.
   */
  public async getArtistPictures(
    artistMbid: string
  ): Promise<ArtistPictures | null> {
    const none = { thumb: null, fanart: null };
    if (!this.apiKey) {
      return none;
    }
    if (this.apiKey === THE_AUDIO_DB_FREE_KEY && !freeTurn()) {
      return null;
    }
    try {
      const data = await this.get<TadbArtistResponse>(
        `/${encodeURIComponent(this.apiKey)}/artist-mb.php`,
        { params: { i: artistMbid } },
        0
      );
      const artist = data.artists?.[0];
      return {
        thumb: artist?.strArtistThumb || null,
        fanart: artist?.strArtistFanart || artist?.strArtistWideThumb || null,
      };
    } catch (e) {
      logger.debug('TheAudioDB could not be asked for artist pictures', {
        label: 'TheAudioDB',
        artistMbid,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }
}

export default TheAudioDb;
