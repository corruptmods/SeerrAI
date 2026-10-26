import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import { SmallLoadingSpinner } from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import { messages as requestMessages } from '@app/components/Music/MusicRequest/shared';
import MusicStatusBadge from '@app/components/Music/MusicStatusBadge';
import type { AlbumGroup } from '@app/components/Music/musicHelpers';
import {
  ALBUM_GROUPS,
  albumGroup,
  allowedByProfile,
  byNewest,
  requestable,
  songName,
  yearOf,
} from '@app/components/Music/musicHelpers';
import FailedRequestAlert, {
  failedMessages,
} from '@app/components/RequestModal/FailedRequestAlert';
import type { MusicOverrides } from '@app/components/RequestModal/MusicAdvancedRequester';
import MusicAdvancedRequester from '@app/components/RequestModal/MusicAdvancedRequester';
import QuotaDisplay from '@app/components/RequestModal/QuotaDisplay';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { retryErrorMessage } from '@app/utils/requestServerIssue';
import {
  MediaRequestStatus,
  MediaStatus,
  VARIOUS_ARTISTS_MBID,
} from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { NonFunctionProperties } from '@server/interfaces/api/common';
import type {
  LidarrServer,
  LidarrServerWithDetails,
} from '@server/interfaces/api/serviceInterfaces';
import type { QuotaResponse } from '@server/interfaces/api/userInterfaces';
import type {
  MusicAlbumDetails,
  MusicAlbumResult,
  MusicArtistDetails,
  MusicPage,
} from '@server/models/Music';
import axios from 'axios';
import { useEffect, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { useSWRConfig } from 'swr';
import useSWRInfinite from 'swr/infinite';

const messages = defineMessages('components.RequestModal.MusicRequestModal', {
  requesttitle: 'Request Music',
  pendingrequest: 'Pending Music Request',
  requestalbums:
    'Request {count, plural, =0 {Albums} one {# Album} other {# Albums}}',
  requestadmin: 'This request will be approved automatically.',
  requestSuccess: '<strong>{title}</strong> requested successfully!',
  requestCancel: 'Request for <strong>{title}</strong> canceled.',
  requestedited: 'Request for <strong>{title}</strong> edited successfully!',
  requestApproved: 'Request for <strong>{title}</strong> approved!',
  requesterror: 'Something went wrong while submitting the request.',
  errorediting: 'Something went wrong while editing the request.',
  edit: 'Edit Request',
  approve: 'Approve Request',
  cancel: 'Cancel Request',
  pendingapproval: 'Your request is pending approval.',
  requestfrom: "{username}'s request is pending approval.",
  albums: 'Albums',
  eps: 'EPs',
  singles: 'Singles',
  other: 'Other Releases',
  otherTip: 'Live albums, compilations, soundtracks, remixes and the rest',
  showOther:
    'Show {count, plural, one {# other release} other {# other releases}}',
  hideOther: 'Hide other releases',
  selectGroup: 'All {group}',
  showMore: 'Show More',
  nothingToRequest:
    'Every release here is already in the library or has been requested.',
  noReleases: 'MusicBrainz lists no releases for this artist.',
  variousArtists:
    'Lidarr cannot add Various Artists, so their compilations cannot be requested.',
  fromProfile: 'Starts with what the Lidarr metadata profile lists.',
});

interface MusicRequestModalProps {
  /** The artist's MusicBrainz id. */
  artistMbid: string;
  /** Opens with only this album ticked: from an album's page or card. */
  albumMbid?: string;
  editRequest?: NonFunctionProperties<MediaRequest>;
  onCancel?: () => void;
  onComplete?: (newStatus: MediaStatus) => void;
  onUpdating?: (isUpdating: boolean) => void;
}

const errorMessage = (e: unknown): string | undefined =>
  axios.isAxiosError(e)
    ? (e.response?.data as { message?: string } | undefined)?.message
    : undefined;

/**
 * Requesting music: the artist's releases in groups, with what the Lidarr
 * metadata profile lists ticked to begin with (or the one album asked from
 * its page), the albums left in the quota, and the advanced options. One
 * request, approved once, whether for an album or a whole discography.
 */
const MusicRequestModal = ({
  artistMbid,
  albumMbid,
  editRequest,
  onCancel,
  onComplete,
  onUpdating,
}: MusicRequestModalProps) => {
  const intl = useIntl();
  const { user, hasPermission } = useUser();
  const { addToast } = useToasts();
  const { mutate: globalMutate } = useSWRConfig();
  const [isUpdating, setIsUpdating] = useState(false);
  const [showOther, setShowOther] = useState(false);
  const [selected, setSelected] = useState<string[] | null>(
    editRequest
      ? editRequest.albums.map((album) => album.albumMbid)
      : albumMbid
        ? [albumMbid]
        : null
  );
  // A request whose Lidarr was removed starts from the default server and
  // that server's own settings, as a new request would.
  const kept = editRequest?.serverIssue ? undefined : editRequest;
  const [overrides, setOverrides] = useState<MusicOverrides>({
    server: kept?.serverId ?? undefined,
    profile: kept?.profileId ?? undefined,
    metadataProfile: kept?.metadataProfileId ?? undefined,
    folder: kept?.rootFolder ?? undefined,
    tags: kept?.tags ?? undefined,
    userId: editRequest?.requestedBy.id,
  });
  // A failed request is changed by a request manager and then retried.
  const isFailed = editRequest?.status === MediaRequestStatus.FAILED;
  const advanced = hasPermission(
    [Permission.REQUEST_ADVANCED, Permission.MANAGE_REQUESTS],
    { type: 'or' }
  );
  const variousArtists = artistMbid === VARIOUS_ARTISTS_MBID;

  const { data: artist, error: artistError } = useSWR<MusicArtistDetails>(
    `/api/v1/music/artist/${artistMbid}`
  );
  const {
    data: pages,
    error: albumsError,
    size,
    setSize,
    isValidating: loadingAlbums,
  } = useSWRInfinite<MusicPage<MusicAlbumResult>>(
    (index, previous: MusicPage<MusicAlbumResult> | null) =>
      previous && index + 1 > previous.totalPages
        ? null
        : `/api/v1/music/artist/${artistMbid}/albums?page=${index + 1}`
  );
  // The album asked for from its page, in case it is not among the first
  // hundred of a long discography.
  const { data: askedAlbum } = useSWR<MusicAlbumDetails>(
    albumMbid ? `/api/v1/music/album/${albumMbid}` : null
  );
  const { data: servers } = useSWR<LidarrServer[]>('/api/v1/service/lidarr');
  const serverId =
    overrides.server ?? servers?.find((server) => server.isDefault)?.id;
  const { data: serverData, error: serverError } =
    useSWR<LidarrServerWithDetails>(
      serverId !== undefined
        ? `/api/v1/service/lidarr/${serverId}?artist=${artistMbid}`
        : null
    );
  const quotaUserId = overrides.userId ?? user?.id;
  const quotaKey =
    !editRequest &&
    quotaUserId &&
    (quotaUserId === user?.id || hasPermission(Permission.MANAGE_USERS))
      ? `/api/v1/user/${quotaUserId}/quota`
      : null;
  const { data: quota } = useSWR<QuotaResponse>(quotaKey);

  useEffect(() => {
    onUpdating?.(isUpdating);
  }, [isUpdating, onUpdating]);

  // The server's own choices fill in what the advanced options start at.
  useEffect(() => {
    if (!serverData) {
      return;
    }
    setOverrides((current) => ({
      ...current,
      server: current.server ?? serverData.server.id,
      profile: current.profile ?? serverData.server.activeProfileId,
      metadataProfile:
        current.metadataProfile ?? serverData.server.activeMetadataProfileId,
      folder: current.folder ?? serverData.server.activeDirectory,
      tags: current.tags ?? serverData.server.activeTags,
    }));
  }, [serverData]);

  const albums = useMemo(() => {
    const listed = (pages ?? []).flatMap((page) => page.results ?? []);
    if (askedAlbum && !listed.some((album) => album.id === askedAlbum.id)) {
      listed.push(askedAlbum);
    }
    return listed.sort(byNewest);
  }, [pages, askedAlbum]);

  // An artist Lidarr has lists what its own metadata profile allows.
  const kinds = serverData?.metadataProfiles.find(
    (profile) =>
      profile.id ===
      (serverData.artist?.metadataProfileId ??
        overrides.metadataProfile ??
        serverData.server.activeMetadataProfileId)
  );

  const inThisRequest = editRequest?.albums.map((album) => album.albumMbid);
  const canTick = (album: MusicAlbumResult) =>
    !variousArtists &&
    (requestable(album.status) || !!inThisRequest?.includes(album.id));

  // From an artist's page, what Lidarr would list for them starts ticked.
  useEffect(() => {
    if (selected !== null || !pages) {
      return;
    }
    if (serverError || (serverData && !kinds)) {
      setSelected([]);
    } else if (kinds) {
      setSelected(
        albums
          .filter((album) => canTick(album) && allowedByProfile(album, kinds))
          .map((album) => album.id)
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, kinds, serverData, serverError, selected]);

  const chosen = selected ?? [];
  const toggle = (ids: string[], on: boolean) =>
    setSelected((current) =>
      on
        ? [...new Set([...(current ?? []), ...ids])]
        : (current ?? []).filter((id) => !ids.includes(id))
    );

  const autoApproves = hasPermission(
    [
      Permission.MANAGE_REQUESTS,
      Permission.AUTO_APPROVE,
      Permission.AUTO_APPROVE_MUSIC,
    ],
    { type: 'or' }
  );
  const quotaLimited = (quota?.music.limit ?? 0) > 0;
  const overQuota =
    quotaLimited &&
    !overrides.ignoreQuota &&
    chosen.length > (quota?.music.remaining ?? 0);
  const title =
    chosen.length === 1
      ? (albums.find((album) => album.id === chosen[0])?.title ??
        artist?.name ??
        '')
      : (artist?.name ?? '');

  const refresh = () => {
    globalMutate('/api/v1/request?filter=all&take=10&sort=modified&skip=0');
    globalMutate('/api/v1/request/count');
  };

  const choices = () =>
    advanced
      ? {
          serverId: overrides.server,
          profileId: overrides.profile,
          metadataProfileId: overrides.metadataProfile,
          rootFolder: overrides.folder,
          tags: overrides.tags,
        }
      : {};

  const sendRequest = async () => {
    setIsUpdating(true);
    try {
      await axios.post('/api/v1/request/music', {
        artistMbid,
        albums: chosen,
        ...choices(),
        userId:
          overrides.userId && overrides.userId !== user?.id
            ? overrides.userId
            : undefined,
        ignoreQuota: overrides.ignoreQuota || undefined,
      });
      refresh();
      addToast(
        <span>
          {intl.formatMessage(messages.requestSuccess, {
            title,
            strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
          })}
        </span>,
        { appearance: 'success', autoDismiss: true }
      );
      onComplete?.(autoApproves ? MediaStatus.PROCESSING : MediaStatus.PENDING);
    } catch (e) {
      addToast(errorMessage(e) ?? intl.formatMessage(messages.requesterror), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const updateRequest = async (alsoApprove = false) => {
    if (!editRequest) {
      return;
    }
    setIsUpdating(true);
    try {
      await axios.put(`/api/v1/request/${editRequest.id}`, {
        mediaType: 'music',
        albums: chosen,
        ...choices(),
        userId: overrides.userId,
      });
      if (isFailed) {
        await axios.post(`/api/v1/request/${editRequest.id}/retry`);
      } else if (alsoApprove) {
        await axios.post(`/api/v1/request/${editRequest.id}/approve`);
      }
      refresh();
      addToast(
        <span>
          {intl.formatMessage(
            isFailed
              ? failedMessages.retried
              : alsoApprove
                ? messages.requestApproved
                : messages.requestedited,
            {
              title,
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            }
          )}
        </span>,
        { appearance: 'success', autoDismiss: true }
      );
      onComplete?.(isFailed ? MediaStatus.PROCESSING : MediaStatus.PENDING);
    } catch (e) {
      addToast(
        isFailed
          ? retryErrorMessage(
              e,
              intl,
              false,
              intl.formatMessage(messages.errorediting)
            )
          : (errorMessage(e) ?? intl.formatMessage(messages.errorediting)),
        {
          appearance: 'error',
          autoDismiss: true,
        }
      );
    } finally {
      setIsUpdating(false);
    }
  };

  const cancelRequest = async () => {
    if (!editRequest) {
      return;
    }
    setIsUpdating(true);
    try {
      await axios.delete(`/api/v1/request/${editRequest.id}`);
      refresh();
      addToast(
        <span>
          {intl.formatMessage(messages.requestCancel, {
            title,
            strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
          })}
        </span>,
        { appearance: 'success', autoDismiss: true }
      );
      onComplete?.(MediaStatus.UNKNOWN);
    } catch {
      setIsUpdating(false);
    }
  };

  const more = size < (pages?.[pages.length - 1]?.totalPages ?? 1);
  const groups = Object.fromEntries(
    ALBUM_GROUPS.map((group) => [
      group,
      albums.filter((album) => albumGroup(album) === group),
    ])
  ) as Record<AlbumGroup, MusicAlbumResult[]>;
  const anyTickable = albums.some(canTick);

  const groupList = (group: AlbumGroup) => {
    const list = groups[group];
    const tickable = list.filter(canTick).map((album) => album.id);
    const allOn =
      tickable.length > 0 && tickable.every((id) => chosen.includes(id));
    const name = intl.formatMessage(messages[group]);
    return (
      <section key={group} className="mt-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold text-gray-200">{name}</h3>
          {tickable.length > 1 && (
            <label className="flex items-center gap-2 text-sm text-gray-300">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-gray-600 bg-gray-700 text-indigo-600"
                checked={allOn}
                onChange={() => toggle(tickable, !allOn)}
              />
              {intl.formatMessage(messages.selectGroup, {
                group: name.toLowerCase(),
              })}
            </label>
          )}
        </div>
        <ul className="mt-2 divide-y divide-gray-700 overflow-hidden rounded-lg border border-gray-700 backdrop-blur">
          {list.map((album) => {
            const tickableAlbum = canTick(album);
            return (
              <li key={album.id}>
                <label
                  className={`flex items-center gap-3 px-3 py-2 text-sm ${
                    tickableAlbum
                      ? 'cursor-pointer text-gray-100'
                      : 'text-gray-400'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-gray-600 bg-gray-700 text-indigo-600 disabled:opacity-50"
                    checked={tickableAlbum ? chosen.includes(album.id) : true}
                    disabled={!tickableAlbum}
                    onChange={() =>
                      toggle([album.id], !chosen.includes(album.id))
                    }
                  />
                  <span className="min-w-0 flex-1 truncate">{album.title}</span>
                  {!tickableAlbum && <MusicStatusBadge status={album.status} />}
                  <span className="w-10 shrink-0 text-right tabular-nums text-gray-400">
                    {yearOf(album.releaseDate) ?? ''}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </section>
    );
  };

  const albumList = (
    <>
      {variousArtists && (
        <div className="mt-4">
          <Alert title={intl.formatMessage(messages.variousArtists)} />
        </div>
      )}
      {albumsError && !pages ? (
        <div className="mt-4">
          <Alert
            title={intl.formatMessage(messages.requesterror)}
            type="error"
          />
        </div>
      ) : !pages ? (
        <SmallLoadingSpinner />
      ) : !albums.length ? (
        <p className="mt-4 text-gray-400">
          {intl.formatMessage(messages.noReleases)}
        </p>
      ) : (
        <>
          {!variousArtists && !anyTickable && (
            <p className="mt-4 text-gray-400">
              {intl.formatMessage(messages.nothingToRequest)}
            </p>
          )}
          {!editRequest && !albumMbid && kinds && anyTickable && (
            <p className="mt-4 text-sm text-gray-400">
              {intl.formatMessage(messages.fromProfile)}
            </p>
          )}
          {(['albums', 'eps', 'singles'] as const).map(
            (group) => groups[group].length > 0 && groupList(group)
          )}
          {groups.other.length > 0 && (
            <div className="mt-4">
              <p className="text-sm text-gray-400">
                {intl.formatMessage(messages.otherTip)}
              </p>
              <Button
                buttonType="ghost"
                buttonSize="sm"
                className="mt-2"
                aria-expanded={showOther}
                onClick={() => setShowOther(!showOther)}
              >
                {showOther
                  ? intl.formatMessage(messages.hideOther)
                  : intl.formatMessage(messages.showOther, {
                      count: groups.other.length,
                    })}
              </Button>
              {showOther && groupList('other')}
            </div>
          )}
          {more && (
            <div className="mt-4 flex justify-center">
              <Button
                buttonType="primary"
                buttonSize="sm"
                disabled={loadingAlbums}
                onClick={() => setSize(size + 1)}
              >
                {intl.formatMessage(messages.showMore)}
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );

  const advancedOptions = advanced && servers && servers.length > 0 && (
    <MusicAdvancedRequester
      servers={servers}
      serverData={serverData}
      value={overrides}
      onChange={setOverrides}
      quotaLimited={quotaLimited}
    />
  );

  if (editRequest) {
    const isOwner = editRequest.requestedBy.id === user?.id;
    const manages = hasPermission(Permission.MANAGE_REQUESTS);

    return (
      <Modal
        showCloseButton
        loading={!artist && !artistError}
        backgroundClickable
        onCancel={onCancel}
        title={intl.formatMessage(
          isFailed ? failedMessages.title : messages.pendingrequest
        )}
        subTitle={artist?.name}
        onOk={() => updateRequest(manages)}
        // A request for songs alone holds no albums, and is still saved.
        okDisabled={
          isUpdating || (!chosen.length && !editRequest.songs?.length)
        }
        okText={intl.formatMessage(
          isFailed
            ? failedMessages.saveAndRetry
            : manages
              ? messages.approve
              : messages.edit
        )}
        okButtonType={manages && !isFailed ? 'success' : 'primary'}
        onSecondary={isOwner && !isFailed ? () => cancelRequest() : undefined}
        secondaryDisabled={isUpdating}
        secondaryText={
          isOwner && !isFailed ? intl.formatMessage(messages.cancel) : undefined
        }
        secondaryButtonType="danger"
        cancelText={intl.formatMessage(globalMessages.close)}
      >
        {isFailed ? (
          <FailedRequestAlert request={editRequest} />
        ) : isOwner ? (
          intl.formatMessage(messages.pendingapproval)
        ) : (
          intl.formatMessage(messages.requestfrom, {
            username: editRequest.requestedBy.displayName,
          })
        )}
        {!!editRequest.songs?.length && (
          <div className="mt-4">
            <p className="text-label">
              {intl.formatMessage(requestMessages.songs, {
                count: editRequest.songs.length,
              })}
            </p>
            <ul className="mt-1 space-y-1 text-sm text-gray-300">
              {editRequest.songs.map((song) => (
                <li key={song.id} className="truncate">
                  {songName(song.title, song.version)}
                </li>
              ))}
            </ul>
          </div>
        )}
        {albumList}
        {advancedOptions}
      </Modal>
    );
  }

  return (
    <Modal
      showCloseButton
      loading={(!artist && !artistError) || (!!quotaKey && !quota)}
      backgroundClickable
      onCancel={onCancel}
      onOk={sendRequest}
      okDisabled={
        isUpdating ||
        variousArtists ||
        !chosen.length ||
        (quota?.music.restricted && !overrides.ignoreQuota) ||
        overQuota
      }
      title={intl.formatMessage(messages.requesttitle)}
      subTitle={artist?.name}
      okText={
        isUpdating
          ? intl.formatMessage(globalMessages.requesting)
          : intl.formatMessage(messages.requestalbums, {
              count: chosen.length,
            })
      }
      okButtonType="primary"
    >
      {autoApproves && !quota?.music.restricted && (
        <div className="mt-6">
          <Alert
            title={intl.formatMessage(messages.requestadmin)}
            type="info"
          />
        </div>
      )}
      {quotaLimited && (
        <QuotaDisplay
          mediaType="music"
          quota={quota?.music}
          remaining={
            overrides.ignoreQuota
              ? quota?.music.remaining
              : Math.max(0, (quota?.music.remaining ?? 0) - chosen.length)
          }
          userOverride={
            overrides.userId && overrides.userId !== user?.id
              ? overrides.userId
              : undefined
          }
          overLimit={overQuota ? chosen.length : undefined}
        />
      )}
      {albumList}
      {advancedOptions}
    </Modal>
  );
};

export default MusicRequestModal;
