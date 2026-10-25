import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Music.useRequestSong', {
  requested: '<strong>{song}</strong> requested successfully!',
  failed: 'Something went wrong while submitting the request.',
});

/**
 * Asking for one song, a tap away: one version of it (a MusicBrainz
 * recording), as a request of its artist's, with the same approval and
 * limits as an album. Says how it went; `busy` is the version being asked
 * for.
 */
const useRequestSong = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [busy, setBusy] = useState<string>();

  const requestSong = async ({
    artistMbid,
    recordingMbid,
    name,
  }: {
    artistMbid: string;
    recordingMbid: string;
    /** How the song is named in what is said: "Song (radio edit)". */
    name: string;
  }): Promise<boolean> => {
    setBusy(recordingMbid);
    try {
      await axios.post('/api/v1/request/music', {
        artistMbid,
        songs: [recordingMbid],
      });
      addToast(
        <span>
          {intl.formatMessage(messages.requested, {
            song: name,
            strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
          })}
        </span>,
        { appearance: 'success', autoDismiss: true }
      );
      return true;
    } catch (e) {
      const said = axios.isAxiosError(e)
        ? (e.response?.data as { message?: string } | undefined)?.message
        : undefined;
      addToast(said ?? intl.formatMessage(messages.failed), {
        appearance: 'error',
        autoDismiss: true,
      });
      return false;
    } finally {
      setBusy(undefined);
    }
  };

  return { requestSong, busy };
};

export default useRequestSong;
