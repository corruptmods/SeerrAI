import type { DownloadStage, DownloadStep } from '@server/constants/downloads';
import type { DownloadClientSettings } from '@server/lib/settings';

/** One download as its download client reports it, right now. */
export interface LiveDownload {
  size: number;
  sizeLeft: number;
  /** Until it finishes downloading, when the client can say. */
  secondsLeft?: number;
  stage: DownloadStage;
  step?: DownloadStep;
}

export interface DownloadClient {
  /** The client's version; also proves the address and sign-in work. */
  getVersion(): Promise<string>;
  /**
   * The downloads among `ids` that this client holds, by id in lower case.
   * Ids that aren't this client's are passed over.
   */
  getDownloads(ids: string[]): Promise<Map<string, LiveDownload>>;
}

/** Long enough for a busy client, short enough never to hold up a page. */
export const CLIENT_TIMEOUT_MS = 8_000;

export const clientBaseUrl = (
  settings: Pick<
    DownloadClientSettings,
    'hostname' | 'port' | 'useSsl' | 'urlBase'
  >
): string => {
  const base = (settings.urlBase ?? '').replace(/^\/+|\/+$/g, '');
  return `${settings.useSsl ? 'https' : 'http'}://${settings.hostname}:${
    settings.port
  }${base ? `/${base}` : ''}`;
};

/** A torrent's hash: 40 hex characters, or 64 for a v2-only torrent. */
export const isTorrentHash = (id: string): boolean =>
  /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(id);
