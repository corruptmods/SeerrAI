import Button from '@app/components/Common/Button';
import MusicImage from '@app/components/Music/MusicImage';
import MusicStatusBadge from '@app/components/Music/MusicStatusBadge';
import {
  requestable,
  songName,
  trackLength,
} from '@app/components/Music/musicHelpers';
import useRequestSong from '@app/components/Music/useRequestSong';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import type {
  MusicSongResult,
  MusicSongSearchResponse,
  MusicSongVersion,
} from '@server/models/Music';
import Link from 'next/link';
import { Fragment, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Music.SongResults', {
  songs: 'Songs',
  request: 'Request',
  from: 'From {release}',
  onAlbum: 'On {album}',
  moreVersions:
    '{count, plural, one {Show # more version} other {Show # more versions}}',
  fewerVersions: 'Show fewer versions',
  onlyOnAlbums: 'Only on albums',
  onlyOnAlbumsTip:
    'Not released on its own, so it can’t be requested by itself. Request its album instead.',
});

/** Versions shown before the rest are asked for. */
const SHOWN = 3;

const Version = ({
  song,
  version,
  canRequest,
  busy,
  onRequest,
}: {
  song: MusicSongResult;
  version: MusicSongVersion;
  canRequest: boolean;
  busy: boolean;
  onRequest: () => void;
}) => {
  const intl = useIntl();
  const length = trackLength(version.length);
  const from = version.from
    ? intl.formatMessage(messages.from, { release: version.from.title })
    : undefined;
  // A version with no name of its own is named by where it is from.
  const details = [
    version.version ? from : undefined,
    length,
    version.onAlbum && (
      <Link
        href={`/music/album/${version.onAlbum.id}`}
        className="hover:underline"
      >
        {intl.formatMessage(messages.onAlbum, { album: version.onAlbum.title })}
      </Link>
    ),
  ].filter(Boolean);

  return (
    <li className="flex items-center gap-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="break-words text-sm text-gray-200">
          {version.version ?? from ?? song.title}
        </div>
        <div className="break-words text-xs text-muted">
          {details.map((detail, i) => (
            <Fragment key={i}>
              {i > 0 && ' · '}
              {detail}
            </Fragment>
          ))}
        </div>
      </div>
      <div className="shrink-0">
        {!requestable(version.status) ? (
          <MusicStatusBadge status={version.status} plain />
        ) : version.onlyOnAlbums ? (
          canRequest && (
            <span
              className="text-xs text-muted"
              title={intl.formatMessage(messages.onlyOnAlbumsTip)}
            >
              {intl.formatMessage(messages.onlyOnAlbums)}
            </span>
          )
        ) : canRequest ? (
          <Button
            buttonType="primary"
            buttonSize="sm"
            disabled={busy}
            onClick={onRequest}
            aria-label={`${intl.formatMessage(messages.request)}: ${songName(
              song.title,
              version.version
            )}`}
          >
            <ArrowDownTrayIcon />
            <span>{intl.formatMessage(messages.request)}</span>
          </Button>
        ) : null}
      </div>
    </li>
  );
};

const Song = ({
  song,
  canRequest,
  isBusy,
  onRequest,
}: {
  song: MusicSongResult;
  canRequest: boolean;
  isBusy: (recordingMbid: string) => boolean;
  onRequest: (version: MusicSongVersion) => void;
}) => {
  const intl = useIntl();
  const [all, setAll] = useState(false);
  const shown = all ? song.versions : song.versions.slice(0, SHOWN);
  const more = song.versions.length - SHOWN;
  const cover = song.versions.find((version) => version.from)?.from;

  return (
    <li className="rounded-lg border border-subtle bg-page p-3">
      <div className="flex items-center gap-3">
        <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded">
          <MusicImage src={cover?.coverUrl} fallback="album" sizes="3rem" />
        </div>
        <div className="min-w-0">
          <div className="break-words font-semibold text-default">
            {song.title}
          </div>
          <Link
            href={`/music/artist/${song.artistId}`}
            className="block break-words text-sm text-muted hover:underline"
          >
            {song.artistName}
          </Link>
        </div>
      </div>
      <ul className="mt-2 divide-y divide-subtle">
        {shown.map((version) => (
          <Version
            key={version.id}
            song={song}
            version={version}
            canRequest={canRequest}
            busy={isBusy(version.id)}
            onRequest={() => onRequest(version)}
          />
        ))}
      </ul>
      {more > 0 && (
        <button
          type="button"
          className="mt-1 text-sm text-accent-soft hover:text-indigo-300 light:text-accent-text light:hover:text-accent-text"
          aria-expanded={all}
          onClick={() => setAll(!all)}
        >
          {all
            ? intl.formatMessage(messages.fewerVersions)
            : intl.formatMessage(messages.moreVersions, { count: more })}
        </button>
      )}
    </li>
  );
};

/**
 * Songs found for a search, once songs can be asked for one at a time:
 * each with its versions (the radio edit, the club mix…), and a Request on
 * each that is not already here or on its way. Asked for apart from the
 * artists and albums, which are not kept waiting for it; nothing found
 * shows nothing.
 */
const SongResults = ({ query }: { query: string }) => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  const { requestSong, isBusy } = useRequestSong();
  const { data, mutate } = useSWR<MusicSongSearchResponse>(
    query
      ? `/api/v1/music/search/songs?query=${encodeURIComponent(query)}`
      : null,
    { revalidateOnFocus: false }
  );
  const songs = data?.songs ?? [];

  if (!songs.length) {
    return null;
  }

  const canRequest = hasPermission(
    [Permission.REQUEST, Permission.REQUEST_MUSIC],
    { type: 'or' }
  );

  return (
    <section>
      <h2 className="mb-3 text-lg font-bold text-gray-200">
        {intl.formatMessage(messages.songs)}
      </h2>
      <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {songs.map((song) => (
          <Song
            key={song.id}
            song={song}
            canRequest={canRequest}
            isBusy={isBusy}
            onRequest={async (version) => {
              await requestSong({
                artistMbid: song.artistId,
                recordingMbid: version.id,
                name: songName(song.title, version.version),
                then: () => mutate(),
              });
            }}
          />
        ))}
      </ul>
    </section>
  );
};

export default SongResults;
