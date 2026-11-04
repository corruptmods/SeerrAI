import ExternalAPI from '@server/api/externalapi';

/*
 * Deezer's public catalog: songs as the stores list them, with each
 * recording's ISRC, the code the industry gives one recording. It needs no
 * key. A playlist's songs are looked up here to be matched on MusicBrainz
 * by that code, and, when MusicBrainz has no such song at all, for the
 * album and track number it is found by.
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
  /** The title with its version ("Song (Live)"). */
  title: string;
  /** The title without it. */
  title_short?: string;
  /** Its version, in brackets, or empty. */
  title_version?: string;
  /** Seconds. */
  duration: number;
  /** Only on a track looked up by its id. */
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

/** Deezer answered with an error of its own (it does so with a 200). */
export class DeezerProblem extends Error {
  constructor(
    message: string,
    /** 800: nothing by that id. 4: asked too often. */
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

/** A phrase for Deezer's search, its quotes taken out. */
const phrase = (text: string): string => text.replace(/["\\]/g, ' ').trim();

class DeezerAPI extends ExternalAPI {
  constructor() {
    // Deezer allows 50 requests in 5 seconds; this stays well inside it.
    super(
      DEEZER_URL,
      {},
      { timeout: TIMEOUT_MS, rateLimit: { maxRequests: 4, maxRPS: 4 } }
    );
  }

  /** Tracks by this artist with this title, best known first. */
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

  /** One track, with its ISRC and where it is on its album. */
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
