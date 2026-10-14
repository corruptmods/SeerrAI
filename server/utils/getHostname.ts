import { connectedKindsOf, getSettings } from '@server/lib/settings';

interface HostnameParams {
  useSsl?: boolean;
  ip?: string;
  port?: number;
  urlBase?: string;
}

/**
 * A Jellyfin or Emby server's address from its settings. Without them, the
 * connected Jellyfin-family server's (Emby's when that is the one). Code
 * that knows which server it means uses hostnameFor(kind) in
 * lib/mediaServers instead.
 */
export const getHostname = (params?: HostnameParams): string => {
  const server = params ?? jellyfinFamilySettings();

  const { useSsl, ip, port, urlBase } = server;

  const hostname = `${useSsl ? 'https' : 'http'}://${ip}:${port}${urlBase}`;

  return hostname;
};

const jellyfinFamilySettings = (): HostnameParams => {
  const settings = getSettings();
  const kind = connectedKindsOf(settings).find(
    (k) => k === 'jellyfin' || k === 'emby'
  );
  return kind === 'emby' ? settings.emby : settings.jellyfin;
};
