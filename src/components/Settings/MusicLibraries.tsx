import LibraryItem from '@app/components/Settings/LibraryItem';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import type { MusicLibrary } from '@server/lib/settings';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Settings.MusicLibraries', {
  musicLibraries: 'Music Libraries',
  musicLibrariesDescription:
    'The music libraries Seerr AI reads to find which albums are here. Sync Libraries above lists them. While no music library is switched on, on any server, Lidarr’s files decide what is here.',
  noMusicLibraries:
    'No music libraries were found. Sync Libraries above to look again.',
  toggleFailure: 'Failed to update library.',
});

/** Where a server's music libraries are read, so a sync can refresh them. */
export const musicLibrariesKey = (endpoint: string): string =>
  `${endpoint}/music-library`;

interface MusicLibrariesProps {
  /** The server's settings, e.g. /api/v1/settings/plex. */
  endpoint: string;
}

/**
 * A server's music libraries, to switch on or off. Only while music is set
 * up and on.
 */
const MusicLibraries = ({ endpoint }: MusicLibrariesProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { currentSettings } = useSettings();
  const [busy, setBusy] = useState(false);
  const { data, mutate } = useSWR<MusicLibrary[]>(
    currentSettings.musicReady ? musicLibrariesKey(endpoint) : null
  );

  if (!currentSettings.musicReady) {
    return null;
  }

  const toggle = async (library: MusicLibrary) => {
    if (busy) return;
    setBusy(true);
    try {
      await axios.put(`${musicLibrariesKey(endpoint)}/${library.id}`, {
        enabled: !library.enabled,
      });
    } catch {
      addToast(intl.formatMessage(messages.toggleFailure), {
        autoDismiss: true,
        appearance: 'error',
      });
    } finally {
      setBusy(false);
      mutate();
    }
  };

  return (
    <>
      <div className="mb-6 mt-10">
        <h3 className="heading">
          {intl.formatMessage(messages.musicLibraries)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.musicLibrariesDescription)}
        </p>
      </div>
      <div className="section">
        {data && data.length === 0 ? (
          <p className="text-sm text-gray-400">
            {intl.formatMessage(messages.noMusicLibraries)}
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-6 lg:grid-cols-4">
            {(data ?? []).map((library) => (
              <LibraryItem
                name={library.name}
                isEnabled={library.enabled}
                key={`music-library-${library.id}`}
                onToggle={() => toggle(library)}
              />
            ))}
          </ul>
        )}
      </div>
    </>
  );
};

export default MusicLibraries;
