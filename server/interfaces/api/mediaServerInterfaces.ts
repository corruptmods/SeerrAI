import type { MediaServerKind } from '@server/constants/server';

/** A media server as Settings → Media Servers shows it. */
export interface MediaServerSummary {
  kind: MediaServerKind;
  /** The server's own name, once connected. */
  name: string;
  connected: boolean;
  primary: boolean;
  signIn: boolean;
  libraries: number;
  enabledLibraries: number;
  /** Last scan of an enabled library, epoch ms. */
  lastScan?: number;
  /** Last reachable address, for reconnecting. */
  address: {
    ip: string;
    port: number;
    useSsl: boolean;
    urlBase?: string;
    externalHostname?: string;
    webAppUrl?: string;
  };
  /** The owner's (user 1) linked account, if any. */
  ownerAccount?: string;
}

/** Users who would lose sign-in methods if the server were removed. */
export interface MediaServerRemovalImpact {
  /** Left with password sign-in only. */
  passwordOnly: number;
  /** Left unable to sign in. */
  noSignIn: number;
}

/** An administrator of a Jellyfin or Emby server. */
export interface MediaServerAdmin {
  id: string;
  name: string;
}
