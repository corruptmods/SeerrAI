import Button from '@app/components/Common/Button';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import SlideOver from '@app/components/Common/SlideOver';
import DownloadBlock from '@app/components/DownloadBlock';
import MediaHistory from '@app/components/ManageSlideOver/MediaHistory';
import RequestBlock from '@app/components/RequestBlock';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { SERVER_NAMES } from '@app/utils/mediaServerAccounts';
import {
  ArrowTopRightOnSquareIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/outline';
import { DocumentMinusIcon } from '@heroicons/react/24/solid';
import type { MusicArtistDetails } from '@server/models/Music';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Music.MusicManage', {
  manageArtist: 'Manage Artist',
  downloads: 'Downloads',
  requests: 'Requests',
  advanced: 'Advanced',
  openInLidarr: 'Open in Lidarr',
  searchMissing: 'Search Lidarr for Missing Albums',
  searchMissingHelp:
    'Asks Lidarr to search now for each album asked for that it has no files for yet.',
  searchStarted:
    '{count, plural, one {Searching for # missing album} other {Searching for # missing albums}} in {service}.',
  searchFailed: 'Could not start the search.',
  clearData: 'Clear Data',
  clearDataWarning:
    '* This removes everything Seerr AI keeps about this artist, their albums and every request for them. Nothing is taken out of Lidarr. Albums in your {mediaServerName} music library come back with the next music scan.',
  clearDataFailed: 'Something went wrong while clearing the artist’s data.',
});

interface MusicManageProps {
  show: boolean;
  artist: MusicArtistDetails;
  onClose: () => void;
  revalidate: () => void;
}

/**
 * An artist's manage panel, for request managers and admins: what Lidarr is
 * downloading, the requests, what has happened to the artist and their
 * albums, and (for admins) Lidarr and clearing Seerr's own record.
 */
const MusicManage = ({
  show,
  artist,
  onClose,
  revalidate,
}: MusicManageProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { hasPermission } = useUser();
  const settings = useSettings();
  const [searching, setSearching] = useState(false);
  const media = artist.mediaInfo;
  const downloads = media?.downloadStatus ?? [];
  const requests = media?.requests ?? [];
  const isAdmin = hasPermission(Permission.ADMIN);

  const searchMissing = async () => {
    if (!media) return;
    setSearching(true);
    try {
      const { data } = await axios.post<{ service: string; searched: number }>(
        `/api/v1/media/${media.id}/search-missing`,
        {}
      );
      addToast(
        intl.formatMessage(messages.searchStarted, {
          count: data.searched,
          service: data.service,
        }),
        { appearance: 'success', autoDismiss: true }
      );
    } catch (e) {
      addToast(
        e?.response?.data?.message ?? intl.formatMessage(messages.searchFailed),
        { appearance: 'error', autoDismiss: true }
      );
    } finally {
      setSearching(false);
    }
  };

  const clearData = async () => {
    if (!media) return;
    try {
      await axios.delete(`/api/v1/media/${media.id}`);
      revalidate();
      onClose();
    } catch {
      addToast(intl.formatMessage(messages.clearDataFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };

  return (
    <SlideOver
      show={show}
      title={intl.formatMessage(messages.manageArtist)}
      subText={artist.name}
      onClose={onClose}
    >
      <div className="space-y-6">
        {downloads.length > 0 && (
          <div>
            <h3 className="mb-2 text-xl font-bold">
              {intl.formatMessage(messages.downloads)}
            </h3>
            <div className="overflow-hidden rounded-md border border-gray-700 shadow">
              <ul>
                {downloads.map((item, index) => (
                  <li
                    key={`dl-${item.downloadId}-${index}`}
                    className="border-b border-gray-700 last:border-b-0"
                  >
                    <DownloadBlock downloadItem={item} title={artist.name} />
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
        {requests.length > 0 && (
          <div>
            <h3 className="mb-2 text-xl font-bold">
              {intl.formatMessage(messages.requests)}
            </h3>
            <div className="overflow-hidden rounded-md border border-gray-700 shadow">
              <ul>
                {requests.map((request) => (
                  <li
                    key={`manage-request-${request.id}`}
                    className="border-b border-gray-700 last:border-b-0"
                  >
                    <RequestBlock request={request} onUpdate={revalidate} />
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
        <MediaHistory artistId={artist.id} />
        {isAdmin && media && (
          <div>
            <h3 className="mb-2 text-xl font-bold">
              {intl.formatMessage(messages.advanced)}
            </h3>
            <div className="space-y-2">
              {media.serviceUrl && (
                <Button
                  as="a"
                  href={media.serviceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full"
                  buttonType="ghost"
                >
                  <ArrowTopRightOnSquareIcon />
                  <span>{intl.formatMessage(messages.openInLidarr)}</span>
                </Button>
              )}
              {media.externalServiceId != null && (
                <div>
                  <Button
                    onClick={() => searchMissing()}
                    className="w-full"
                    buttonType="ghost"
                    disabled={searching}
                  >
                    <MagnifyingGlassIcon />
                    <span>{intl.formatMessage(messages.searchMissing)}</span>
                  </Button>
                  <div className="mt-2 text-xs text-gray-400">
                    {intl.formatMessage(messages.searchMissingHelp)}
                  </div>
                </div>
              )}
              <div>
                <ConfirmButton
                  onClick={() => clearData()}
                  confirmText={intl.formatMessage(globalMessages.areyousure)}
                  className="w-full"
                >
                  <DocumentMinusIcon />
                  <span>{intl.formatMessage(messages.clearData)}</span>
                </ConfirmButton>
                <div className="mt-2 text-xs text-gray-400">
                  {intl.formatMessage(messages.clearDataWarning, {
                    mediaServerName: intl.formatList(
                      settings.currentSettings.mediaServers.map(
                        (server) => SERVER_NAMES[server.kind]
                      ),
                      { type: 'disjunction' }
                    ),
                  })}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </SlideOver>
  );
};

export default MusicManage;
