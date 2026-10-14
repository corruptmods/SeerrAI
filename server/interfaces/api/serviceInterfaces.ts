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

/** Which kinds of release a metadata profile has Lidarr list. */
export interface LidarrMetadataProfileSummary {
  id: number;
  name: string;
  /** Album, EP, Single, Broadcast, Other: the allowed ones. */
  primaryTypes: string[];
  /** Live, Compilation, Studio and so on: the allowed ones. */
  secondaryTypes: string[];
}

/** An artist already in Lidarr: its folder and profiles stay its own. */
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
  /** With `?artist=`: the artist, if this Lidarr has them. */
  artist: LidarrArtistSummary | null;
}
