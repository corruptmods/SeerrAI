import { MediaServerType } from '@server/constants/server';
import type { PublicSettingsResponse } from '@server/interfaces/api/settingsInterfaces';
import React from 'react';
import useSWR from 'swr';

export interface SettingsContextProps {
  currentSettings: PublicSettingsResponse;
  children?: React.ReactNode;
}

const defaultSettings = {
  initialized: false,
  applicationTitle: 'Seerr AI',
  applicationUrl: '',
  disabledFeatures: [] as string[],
  animeExcludedCountries: [] as string[],
  hideAvailable: false,
  hideBlocklisted: false,
  hideRequested: false,
  localLogin: true,
  mediaServerLogin: true,
  mediaServers: [],
  oidcProviders: [],
  movie4kEnabled: false,
  series4kEnabled: false,
  discoverRegion: '',
  streamingRegion: '',
  originalLanguage: '',
  mediaServerType: MediaServerType.NOT_CONFIGURED,
  partialRequestsEnabled: true,
  enableSpecialEpisodes: false,
  cacheImages: false,
  vapidPublic: '',
  enablePushRegistration: false,
  locale: 'en',
  emailEnabled: false,
  newPlexLogin: true,
  youtubeUrl: '',
  versionCheck: true,
  plexClientIdentifier: '',
  aiReady: false,
  subtitlesReady: false,
  traktReady: false,
  musicReady: false,
};

export const SettingsContext = React.createContext<SettingsContextProps>({
  currentSettings: defaultSettings,
});

export const SettingsProvider = ({
  children,
  currentSettings,
}: SettingsContextProps) => {
  const { data } = useSWR<PublicSettingsResponse>('/api/v1/settings/public', {
    fallbackData: currentSettings,
  });

  // A failed refresh keeps the settings last loaded (SWR holds on to them):
  // falling back to the defaults would turn features off until it next
  // succeeded.
  const newSettings = data ?? defaultSettings;

  return (
    <SettingsContext.Provider value={{ currentSettings: newSettings }}>
      {children}
    </SettingsContext.Provider>
  );
};
