import type { MediaServerKind } from '@server/constants/server';

/** A media server as Settings → Media Servers shows it. */
export interface MediaServerSummary {
  kind: MediaServerKind;
  /** The server's own name, once Seerr has been connected to it. */
  name: string;
  connected: boolean;
  primary: boolean;
  signIn: boolean;
  libraries: number;
  enabledLibraries: number;
  /** When an enabled library was last scanned, in milliseconds. */
  lastScan?: number;
  /** Where Seerr last reached it, to connect again. */
  address: {
    ip: string;
    port: number;
    useSsl: boolean;
    urlBase?: string;
    externalHostname?: string;
    webAppUrl?: string;
  };
  /** The owner's (user 1's) account on it, when one is linked. */
  ownerAccount?: string;
}

/** How many people removing a server would leave with fewer ways in. */
export interface MediaServerRemovalImpact {
  /** People who could then sign in only with their password. */
  passwordOnly: number;
  /** People who could then not sign in at all. */
  noSignIn: number;
}

/** An administrator of a Jellyfin or Emby server. */
export interface MediaServerAdmin {
  id: string;
  name: string;
}
