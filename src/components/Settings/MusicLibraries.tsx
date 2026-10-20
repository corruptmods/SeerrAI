import LibraryItem from '@app/components/Settings/LibraryItem';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import type { MusicLibrary } from '@server/lib/settings';
import axios from 'axios';
import Link from 'next/link';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Settings.MusicLibraries', {
  musicLibraries: 'Music Libraries',
  musicLibrariesDescription:
    'The music libraries that show which albums are here. With none on, anywhere, Lidarr’s files decide.',
  noMusicLibraries:
    'No music libraries were found. Sync Libraries above to look again.',
  musicOff:
    'Music libraries appear once music is on in <link>Settings → Music</link>.',
  toggleFailure: 'Failed to update library.',
});

/** Where a server's music libraries are read, so a sync can refresh them. */
export const musicLibrariesKey = (endpoint: string): string =>
  `${endpoint}/music-library`;

/**
 * A server's music libraries and switching one on or off. Only read while
 * music is set up and on for everyone (`ready` says whether it is), and
 * not before `read` is true.
 */
export const useMusicLibraries = (endpoint: string, read = true) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { currentSettings } = useSettings();
  const [busy, setBusy] = useState(false);
  const { data, mutate } = useSWR<MusicLibrary[]>(
    currentSettings.musicReady && read ? musicLibrariesKey(endpoint) : null
  );

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

  return { ready: currentSettings.musicReady, data, toggle };
};

/**
 * Said where music libraries would be listed while music is off. During
 * first-time setup there is no Settings → Music to go to yet, so it isn't
 * a link there.
 */
export const MusicLibrariesOff = ({ linked }: { linked: boolean }) => {
  const intl = useIntl();
  return (
    <p className="text-sm text-gray-400">
      {intl.formatMessage(messages.musicOff, {
        link: (chunks: React.ReactNode) =>
          linked ? (
            <Link
              href="/settings/music"
              className="text-strong transition duration-300 hover:underline"
            >
              {chunks}
            </Link>
          ) : (
            <span className="text-strong">{chunks}</span>
          ),
      })}
    </p>
  );
};

interface MusicLibrariesProps {
  /** The server's settings, e.g. /api/v1/settings/plex. */
  endpoint: string;
  /**
   * First-time setup: while music is off, says when music libraries can be
   * chosen rather than showing nothing.
   */
  isSetup?: boolean;
}

/**
 * A server's music libraries, to switch on or off. Only while music is set
 * up and on.
 */
const MusicLibraries = ({ endpoint, isSetup }: MusicLibrariesProps) => {
  const intl = useIntl();
  const { ready, data, toggle } = useMusicLibraries(endpoint);

  if (!ready && !isSetup) {
    return null;
  }

  return (
    <>
      <div className="mb-6 mt-10">
        <h3 className="heading">
          {intl.formatMessage(messages.musicLibraries)}
        </h3>
        {ready && (
          <p className="description">
            {intl.formatMessage(messages.musicLibrariesDescription)}
          </p>
        )}
      </div>
      <div className="section">
        {!ready ? (
          <MusicLibrariesOff linked={false} />
        ) : data && data.length === 0 ? (
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
