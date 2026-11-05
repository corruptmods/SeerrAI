import Button from '@app/components/Common/Button';
import { CoverArt } from '@app/components/Music/MusicCard';
import MusicStatusBadge from '@app/components/Music/MusicStatusBadge';
import { requestable, songName } from '@app/components/Music/musicHelpers';
import useRequestSong from '@app/components/Music/useRequestSong';
import CardShell, {
  NoPicture,
  useCardDetail,
} from '@app/components/TitleCard/CardShell';
import Placeholder from '@app/components/TitleCard/Placeholder';
import useFeature from '@app/hooks/useFeature';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import { MediaStatus } from '@server/constants/media';
import type { MusicSongResult } from '@server/models/Music';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Music.SongCard', {
  song: 'Song',
});

interface SongCardProps {
  song: MusicSongResult;
  /** Fills a grid cell instead of a row's fixed width. */
  canExpand?: boolean;
  /** Refetches whatever shows the song, after a request. */
  onRequested?: () => Promise<unknown>;
}

/**
 * A chart song card: its best-known album or single's cover, status, and
 * Request. Links to that release; a song with no single of its own is
 * requested there, with its album.
 */
const SongCard = ({ song, canExpand, onRequested }: SongCardProps) => {
  const intl = useIntl();
  const musicOn = useFeature('music');
  const { hasPermission } = useUser();
  const detail = useCardDetail();
  const { requestSong, isBusy } = useRequestSong();
  const [missing, setMissing] = useState(false);
  // Shown right after a request from the card, before the row reloads.
  const [requested, setRequested] = useState(false);
  const version = song.versions[0];
  const from = version?.from;
  const status = requested ? MediaStatus.PENDING : version?.status;

  useEffect(() => {
    setMissing(false);
  }, [from?.coverUrl]);

  // The refetched row now has the real status.
  useEffect(() => {
    setRequested(false);
  }, [version?.status]);

  const showRequest =
    musicOn &&
    !!version &&
    song.canRequest !== false &&
    !version.onlyOnAlbums &&
    requestable(status) &&
    hasPermission([Permission.REQUEST, Permission.REQUEST_MUSIC], {
      type: 'or',
    });

  return (
    <CardShell
      captioned
      detail={detail}
      canExpand={canExpand}
      testId="song-card"
      image={
        missing || !from ? (
          <NoPicture />
        ) : (
          <CoverArt src={from.coverUrl} onMissing={() => setMissing(true)} />
        )
      }
      badge={{
        label: intl.formatMessage(messages.song),
        className: 'border-pink-600 bg-pink-600/fill light:bg-pink-700',
      }}
      indicators={<MusicStatusBadge status={status} mini />}
      showOverlay={missing || !from || detail.showDetail}
      href={from ? `/music/album/${from.id}` : `/music/artist/${song.artistId}`}
      title={song.title}
      summary={song.artistName}
      roomForActions={showRequest}
      actions={
        showRequest && (
          <Button
            buttonType="primary"
            buttonSize="sm"
            disabled={isBusy(version.id)}
            onClick={async (e) => {
              e.preventDefault();
              const done = await requestSong({
                artistMbid: song.artistId,
                recordingMbid: version.id,
                name: songName(song.title, version.version),
                then: onRequested,
              });
              if (done) setRequested(true);
            }}
            className="h-7 w-full"
          >
            <ArrowDownTrayIcon />
            <span>{intl.formatMessage(globalMessages.request)}</span>
          </Button>
        )
      }
    />
  );
};

/** Loading placeholder, as for films. */
SongCard.Placeholder = Placeholder;

export default SongCard;
