import ExternalAPI from '@server/api/externalapi';

/*
 * Deezer's keyless public catalog, with each recording's ISRC. Playlist songs
 * are looked up here to match on MusicBrainz by ISRC, or, when MusicBrainz
 * lacks the song, by album and track number.
 */

export const DEEZER_URL = 'https://api.deezer.com';

const TIMEOUT_MS = 15_000;

export interface DeezerArtist {
  id: number;
  name: string;
}

export interface DeezerAlbum {
  id: number;
  title: string;
  release_date?: string;
  cover_xl?: string;
}

export interface DeezerTrack {
  id: number;
  /** Title with version ("Song (Live)"). */
  title: string;
  /** Title without version. */
  title_short?: string;
  /** Bracketed version, or empty. */
  title_version?: string;
  /** Seconds. */
  duration: number;
  /** Only on a track fetched by id. */
  isrc?: string;
  track_position?: number;
  disk_number?: number;
  release_date?: string;
  artist: DeezerArtist;
  contributors?: DeezerArtist[];
  album: DeezerAlbum;
}

interface DeezerError {
  error?: { type?: string; message?: string; code?: number };
}

interface DeezerSearch extends DeezerError {
  data?: DeezerTrack[];
}

/** A Deezer error, which it sends with a 200. */
export class DeezerProblem extends Error {
  constructor(
    message: string,
    /** 800: no such id. 4: rate limited. */
    public code?: number
  ) {
    super(message);
  }
}

const checked = <T extends DeezerError>(data: T): T => {
  if (data?.error) {
    throw new DeezerProblem(
      data.error.message || data.error.type || 'Deezer said no',
      data.error.code
    );
  }
  return data;
};

/** A search phrase with quotes and backslashes removed. */
const phrase = (text: string): string => text.replace(/["\\]/g, ' ').trim();

class DeezerAPI extends ExternalAPI {
  constructor() {
    // Deezer allows 50 requests per 5 seconds; stay well under.
    super(
      DEEZER_URL,
      {},
      { timeout: TIMEOUT_MS, rateLimit: { maxRequests: 4, maxRPS: 4 } }
    );
  }

  /** Tracks by this artist with this title, most popular first. */
  public async searchTracks(
    title: string,
    artistName: string,
    limit = 10
  ): Promise<DeezerTrack[]> {
    const data = checked(
      await this.get<DeezerSearch>(
        '/search',
        {
          params: {
            q: `artist:"${phrase(artistName)}" track:"${phrase(title)}"`,
            limit,
          },
        },
        0
      )
    );
    return Array.isArray(data.data) ? data.data : [];
  }

  /** One track with its ISRC and album position. */
  public async getTrack(id: number): Promise<DeezerTrack | null> {
    try {
      return checked(
        await this.get<DeezerTrack & DeezerError>(`/track/${id}`, {}, 0)
      );
    } catch (e) {
      if (e instanceof DeezerProblem && e.code === 800) return null;
      throw e;
    }
  }
}

let shared: DeezerAPI | undefined;

export const deezer = (): DeezerAPI => (shared ??= new DeezerAPI());

export default DeezerAPI;
