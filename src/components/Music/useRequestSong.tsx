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
 * limits as an album. Says how it went; `isBusy` tells each version being
 * asked for, until what shows it has been read again (`then`), so it can't
 * be asked for twice.
 */
const useRequestSong = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

  const requestSong = async ({
    artistMbid,
    recordingMbid,
    name,
    then,
  }: {
    artistMbid: string;
    recordingMbid: string;
    /** How the song is named in what is said: "Song (radio edit)". */
    name: string;
    /** Reads again what shows the song, once it is asked for. */
    then?: () => Promise<unknown>;
  }): Promise<boolean> => {
    if (busy.has(recordingMbid)) return false;
    setBusy((now) => new Set(now).add(recordingMbid));
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
      await then?.();
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
      setBusy((now) => {
        const left = new Set(now);
        left.delete(recordingMbid);
        return left;
      });
    }
  };

  const isBusy = (recordingMbid?: string | null): boolean =>
    !!recordingMbid && busy.has(recordingMbid);

  return { requestSong, isBusy };
};

export default useRequestSong;
