import type { PlaylistService } from '@server/entity/MediaList';
import axios from 'axios';

/*
 * A Spotify or Apple Music playlist, read from its public page as anyone
 * sees it in a browser: no account, no key. Not an API either side
 * promises to keep, so a page that has changed says so plainly. Spotify's
 * page holds the first 100 songs; Apple Music's, those it shows at first.
 */

export interface PlaylistLink {
  service: PlaylistService;
  /** The playlist's own id there. */
  id: string;
  /** The link, tidied: what is kept and read again. */
  url: string;
}

export interface SourceSong {
  /** The service's id for it, unique within the playlist. */
  sourceId: string;
  title: string;
  /** The first artist credited. */
  artistName: string;
  /** Milliseconds, when known. */
  length: number | null;
}

export interface SourcePlaylist {
  name: string;
  songs: SourceSong[];
}

/** Why a playlist could not be read, in words for whoever linked it. */
export class PlaylistSourceError extends Error {}

const TIMEOUT_MS = 20_000;
/** The most songs one playlist brings in. */
export const MAX_SOURCE_SONGS = 500;

const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;

/** What a pasted link is, or null for anything else. */
export const parsePlaylistLink = (text: string): PlaylistLink | null => {
  const raw = text.trim();
  const uri = raw.match(/^spotify:playlist:([A-Za-z0-9]{22})$/);
  if (uri) {
    return {
      service: 'spotify',
      id: uri[1],
      url: `https://open.spotify.com/playlist/${uri[1]}`,
    };
  }
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  if (host === 'open.spotify.com') {
    // /playlist/<id>, /intl-de/playlist/<id>, /embed/playlist/<id>
    const at = parts.indexOf('playlist');
    const id = at >= 0 ? parts[at + 1] : undefined;
    return id && SPOTIFY_ID.test(id)
      ? {
          service: 'spotify',
          id,
          url: `https://open.spotify.com/playlist/${id}`,
        }
      : null;
  }
  if (host === 'music.apple.com' || host === 'embed.music.apple.com') {
    // /<country>/playlist/<slug>/<pl.id>
    const at = parts.indexOf('playlist');
    const id = parts.find((p) => /^pl\.[A-Za-z0-9.-]+$/.test(p));
    const country = /^[a-z]{2}$/.test(parts[0] ?? '') ? parts[0] : 'us';
    return at >= 0 && id
      ? {
          service: 'apple',
          id,
          url: `https://music.apple.com/${country}/playlist/${
            parts[at + 1] && parts[at + 1] !== id ? `${parts[at + 1]}/` : ''
          }${id}`,
        }
      : null;
  }
  return null;
};

/** The JSON a page carries in <script id="…">, or undefined. */
const scriptJson = (html: string, id: string): unknown => {
  const match = html.match(
    new RegExp(`<script[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</script>`)
  );
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]);
  } catch {
    return undefined;
  }
};

const text = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

/** Spotify's embedded player page, as it holds the playlist. */
export const readSpotifyPage = (html: string): SourcePlaylist => {
  const data = scriptJson(html, '__NEXT_DATA__') as
    | {
        props?: {
          pageProps?: {
            state?: {
              data?: {
                entity?: {
                  name?: string;
                  title?: string;
                  trackList?: {
                    uri?: string;
                    title?: string;
                    subtitle?: string;
                    duration?: number;
                  }[];
                };
              };
            };
          };
        };
      }
    | undefined;
  const entity = data?.props?.pageProps?.state?.data?.entity;
  if (!entity || !Array.isArray(entity.trackList)) {
    throw new PlaylistSourceError(
      'Spotify’s page for that playlist has changed, so its songs could not be read.'
    );
  }
  const songs: SourceSong[] = [];
  for (const track of entity.trackList) {
    const title = text(track.title);
    // "Artist A, Artist B": the first is the one credited first.
    const artistName = text(track.subtitle).split(/,\s*/)[0] ?? '';
    const sourceId = text(track.uri);
    if (!title || !artistName || !sourceId.startsWith('spotify:track:')) {
      continue;
    }
    songs.push({
      sourceId,
      title,
      artistName,
      length:
        typeof track.duration === 'number' && track.duration > 0
          ? Math.round(track.duration)
          : null,
    });
  }
  return {
    name: text(entity.name) || text(entity.title) || 'Spotify playlist',
    songs: songs.slice(0, MAX_SOURCE_SONGS),
  };
};

/** Apple Music's playlist page, from the data it is drawn from. */
export const readApplePage = (html: string): SourcePlaylist => {
  interface Item {
    title?: string;
    artistName?: string;
    duration?: number;
    subtitleLinks?: { title?: string }[];
    contentDescriptor?: { identifiers?: { storeAdamID?: string } };
  }
  const data = scriptJson(html, 'serialized-server-data') as
    | {
        data?: {
          data?: { sections?: { itemKind?: string; items?: Item[] }[] };
        }[];
      }
    | undefined;
  const sections = data?.data?.[0]?.data?.sections;
  const tracks = sections?.find((s) => s.itemKind === 'trackLockup');
  if (!sections || !tracks || !Array.isArray(tracks.items)) {
    throw new PlaylistSourceError(
      'Apple Music’s page for that playlist has changed, so its songs could not be read.'
    );
  }
  const header = sections.find(
    (s) => s.itemKind === 'containerDetailHeaderLockup'
  );
  const songs: SourceSong[] = [];
  for (const item of tracks.items) {
    const title = text(item.title);
    const artistName =
      text(item.subtitleLinks?.[0]?.title) ||
      text(item.artistName).split(/\s*(?:,|&)\s*/)[0];
    const id = text(item.contentDescriptor?.identifiers?.storeAdamID);
    if (!title || !artistName || !id) continue;
    songs.push({
      sourceId: `apple:song:${id}`,
      title,
      artistName,
      length:
        typeof item.duration === 'number' && item.duration > 0
          ? Math.round(item.duration)
          : null,
    });
  }
  return {
    name: text(header?.items?.[0]?.title) || 'Apple Music playlist',
    songs: songs.slice(0, MAX_SOURCE_SONGS),
  };
};

/** Reads a linked playlist's name and songs from its public page. */
export const readPlaylist = async (
  link: PlaylistLink
): Promise<SourcePlaylist> => {
  const page =
    link.service === 'spotify'
      ? `https://open.spotify.com/embed/playlist/${link.id}`
      : link.url;
  let html: string;
  try {
    const res = await axios.get<string>(page, {
      timeout: TIMEOUT_MS,
      responseType: 'text',
      headers: {
        // Their pages are made for browsers; a bare client is turned away.
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
        'Accept-Language': 'en',
      },
    });
    html = res.data;
  } catch (e) {
    const status = axios.isAxiosError(e) ? e.response?.status : undefined;
    throw new PlaylistSourceError(
      status === 404
        ? 'That playlist was not found. It may be private: share it, or make it public, and try again.'
        : `${link.service === 'spotify' ? 'Spotify' : 'Apple Music'} could not be reached. Try again in a while.`
    );
  }
  return link.service === 'spotify'
    ? readSpotifyPage(html)
    : readApplePage(html);
};
