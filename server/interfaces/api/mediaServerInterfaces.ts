import type { MediaServerKind } from '@server/constants/server';

/** A media server as Settings → Media Servers shows it. */
export interface MediaServerSummary {
  kind: MediaServerKind;
  /** The server's own name, once connected. */
  name: string;
  connected: boolean;
  primary: boolean;
  signIn: boolean;
  /** Whether people can sign in with this server at all. */
  signInOffered: boolean;
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
  /** Something connecting just changed that the admin should know. */
  notice?: string;
  /**
   * Features this server's connection can't offer, and why in words (Silo:
   * an optional key scope it lacks).
   */
  unavailable?: {
    feature: 'librarySharing' | 'matchCheck';
    reason: string;
  }[];
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
