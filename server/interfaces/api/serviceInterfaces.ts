import type { QualityProfile, RootFolder, Tag } from '@server/api/servarr/base';
import type { LanguageProfile } from '@server/api/servarr/sonarr';

export interface ServiceCommonServer {
  id: number;
  name: string;
  is4k: boolean;
  isDefault: boolean;
  activeProfileId: number;
  activeDirectory: string;
  activeLanguageProfileId?: number;
  activeAnimeProfileId?: number;
  activeAnimeDirectory?: string;
  activeAnimeLanguageProfileId?: number;
  activeTags: number[];
  activeAnimeTags?: number[];
}

export interface ServiceCommonServerWithDetails {
  server: ServiceCommonServer;
  profiles: QualityProfile[];
  rootFolders: Partial<RootFolder>[];
  languageProfiles?: LanguageProfile[];
  tags: Tag[];
}

/** A Lidarr server, for the music request window. */
export interface LidarrServer extends ServiceCommonServer {
  activeMetadataProfileId: number;
}

/** Release kinds a Lidarr metadata profile allows. */
export interface LidarrMetadataProfileSummary {
  id: number;
  name: string;
  /** Allowed among Album, EP, Single, Broadcast, Other. */
  primaryTypes: string[];
  /** Allowed among Live, Compilation, Studio, etc. */
  secondaryTypes: string[];
}

/** An artist already in Lidarr, which keeps its own folder and profiles. */
export interface LidarrArtistSummary {
  id: number;
  path?: string;
  rootFolderPath?: string;
  qualityProfileId: number;
  metadataProfileId: number;
  tags: number[];
  monitored: boolean;
}

export interface LidarrServerWithDetails {
  server: LidarrServer;
  profiles: QualityProfile[];
  metadataProfiles: LidarrMetadataProfileSummary[];
  rootFolders: Partial<RootFolder>[];
  tags: Tag[];
  /** With `?artist=`: the artist, if this Lidarr has it. */
  artist: LidarrArtistSummary | null;
}
