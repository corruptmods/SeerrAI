import ExternalAPI from '@server/api/externalapi';
import logger from '@server/logger';

/*
 * TheAudioDB, for artist pictures Lidarr has none of. Optional: only with a
 * key an admin has entered (Settings → Metadata → Music). Looked up by the
 * artist's MusicBrainz id.
 */

export const THE_AUDIO_DB_URL = 'https://www.theaudiodb.com/api/v1/json';

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

  /** The artist's pictures; none when it is not known or cannot be asked. */
  public async getArtistPictures(artistMbid: string): Promise<ArtistPictures> {
    const none = { thumb: null, fanart: null };
    if (!this.apiKey) {
      return none;
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
      logger.debug('TheAudioDB had no artist pictures', {
        label: 'TheAudioDB',
        artistMbid,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      return none;
    }
  }
}

export default TheAudioDb;
