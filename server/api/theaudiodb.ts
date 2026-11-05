import ExternalAPI from '@server/api/externalapi';
import logger from '@server/logger';

/*
 * Artist pictures Lidarr lacks, by MusicBrainz id. The free key suffices; a
 * supporter key from Settings → Music is used when set. Answers are cached a
 * week (see artistImage).
 */

export const THE_AUDIO_DB_URL = 'https://www.theaudiodb.com/api/v1/json';

export const THE_AUDIO_DB_FREE_KEY = '123';

/**
 * Free-key lookups per minute, well under TheAudioDB's limit. Past it the
 * answer is "could not ask", which isn't cached, so the next visit retries.
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
  /** Square artist picture. */
  thumb: string | null;
  /** Wide background for the artist page. */
  fanart: string | null;
}

class TheAudioDb extends ExternalAPI {
  constructor(private apiKey: string) {
    super(THE_AUDIO_DB_URL, {}, { timeout: TIMEOUT_MS });
  }

  /**
   * The artist's pictures, empty when unknown; null when TheAudioDB could not
   * be asked, which says nothing about whether it has any.
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
