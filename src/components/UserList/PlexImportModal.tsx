import Alert from '@app/components/Common/Alert';
import Modal from '@app/components/Common/Modal';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import axios from 'axios';
import Image from 'next/image';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

interface PlexImportProps {
  onCancel?: () => void;
  onComplete?: () => void;
}

interface PlexImportResponse {
  createdUsers: unknown[];
  refreshedUsers: number;
  /** People left out, because another account has their email. */
  skippedUsers?: { id: string; name: string; reason: string }[];
}

const messages = defineMessages('components.UserList', {
  importfromplex: 'Import Plex Users',
  allusers: 'All users',
  importfromplexerror: 'Something went wrong while importing Plex users.',
  importfromplexnochanges:
    'Plex import completed. No users were created or refreshed.',
  importfromplexsynced:
    'Plex users synced successfully. Existing users were refreshed.',
  syncnotice:
    'You can still click Sync to refresh existing Plex users, such as updated email or username details.',
  importedfromplex:
    '<strong>{userCount}</strong> Plex {userCount, plural, one {user} other {users}} imported successfully!',
  importedPlexUsersNoPassword:
    'Imported users do not have a {applicationTitle} password set. If you disable Plex sign-in, they will need to set a password from their profile or via a password reset link.',
  user: 'User',
  nouserstoimport: 'There are no Plex users to import.',
  plexImportSkipped:
    'Not imported, as another account already has their email: {names}. They can sign in with that account and link Plex from their profile.',
  newplexsigninenabled:
    'The <strong>Enable New Plex Sign-In</strong> setting is currently enabled. Plex users with library access do not need to be imported in order to sign in.',
});

const PlexImportModal = ({ onCancel, onComplete }: PlexImportProps) => {
  const intl = useIntl();
  const settings = useSettings();
  const { addToast } = useToasts();
  const [isImporting, setImporting] = useState(false);
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const { data, error } = useSWR<
    {
      id: string;
      title: string;
      username: string;
      email: string;
      thumb: string;
    }[]
  >(`/api/v1/settings/plex/users`, {
    revalidateOnMount: true,
  });

  const importUsers = async () => {
    setImporting(true);

    try {
      const { data: importResponse } = await axios.post<PlexImportResponse>(
        '/api/v1/user/import-from-plex',
        { plexIds: selectedUsers }
      );

      const { createdUsers, refreshedUsers, skippedUsers } = importResponse;

      if (skippedUsers?.length) {
        addToast(
          intl.formatMessage(messages.plexImportSkipped, {
            names: intl.formatList(skippedUsers.map((user) => user.name)),
          }),
          { autoDismiss: false, appearance: 'warning' }
        );
      }

      if (isSyncOnly) {
        if (refreshedUsers > 0) {
          addToast(intl.formatMessage(messages.importfromplexsynced), {
            autoDismiss: true,
            appearance: 'success',
          });
        } else {
          addToast(intl.formatMessage(messages.importfromplexnochanges), {
            autoDismiss: true,
            appearance: 'info',
          });
        }
      } else if (createdUsers.length > 0) {
        addToast(
          intl.formatMessage(messages.importedfromplex, {
            userCount: createdUsers.length,
            strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
          }),
          {
            autoDismiss: true,
            appearance: 'success',
          }
        );

        addToast(
          intl.formatMessage(messages.importedPlexUsersNoPassword, {
            applicationTitle: settings.currentSettings.applicationTitle,
          }),
          {
            autoDismiss: false,
            appearance: 'warning',
          }
        );
      } else if (refreshedUsers > 0) {
        addToast(intl.formatMessage(messages.importfromplexsynced), {
          autoDismiss: true,
          appearance: 'success',
        });
      } else {
        addToast(intl.formatMessage(messages.importfromplexnochanges), {
          autoDismiss: true,
          appearance: 'info',
        });
      }

      if (onComplete) {
        onComplete();
      }
    } catch {
      addToast(intl.formatMessage(messages.importfromplexerror), {
        autoDismiss: true,
        appearance: 'error',
      });
    } finally {
      setImporting(false);
    }
  };

  const isSelectedUser = (plexId: string): boolean =>
    selectedUsers.includes(plexId);

  const isAllUsers = (): boolean => selectedUsers.length === data?.length;

  const toggleUser = (plexId: string): void => {
    if (selectedUsers.includes(plexId)) {
      setSelectedUsers((users) => users.filter((user) => user !== plexId));
    } else {
      setSelectedUsers((users) => [...users, plexId]);
    }
  };

  const toggleAllUsers = (): void => {
    if (data && selectedUsers.length >= 0 && !isAllUsers()) {
      setSelectedUsers(data.map((user) => user.id));
    } else {
      setSelectedUsers([]);
    }
  };

  const isSyncOnly = !!data && data.length === 0;

  return (
    <Modal
      loading={!data && !error}
      title={intl.formatMessage(messages.importfromplex)}
      onOk={() => {
        importUsers();
      }}
      okDisabled={
        isImporting || !data || (data.length > 0 && !selectedUsers.length)
      }
      okText={intl.formatMessage(
        isImporting
          ? isSyncOnly
            ? globalMessages.syncing
            : globalMessages.importing
          : isSyncOnly
            ? globalMessages.sync
            : globalMessages.import
      )}
      onCancel={onCancel}
    >
      {data?.length ? (
        <>
          {settings.currentSettings.newPlexLogin && (
            <Alert
              title={intl.formatMessage(messages.newplexsigninenabled, {
                strong: (msg: React.ReactNode) => (
                  <strong className="font-semibold text-strong">{msg}</strong>
                ),
              })}
              type="info"
            />
          )}
          <div className="flex flex-col">
            <div className="-mx-4 sm:mx-0">
              <div className="inline-block min-w-full py-2 align-middle">
                <div className="overflow-hidden shadow sm:rounded-lg">
                  <table className="min-w-full">
                    <thead>
                      <tr>
                        <th className="w-16 bg-gray-500 px-4 py-3">
                          <span
                            role="checkbox"
                            tabIndex={0}
                            aria-checked={isAllUsers()}
                            aria-label={intl.formatMessage(messages.allusers)}
                            onClick={() => toggleAllUsers()}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                toggleAllUsers();
                              }
                            }}
                            className="relative inline-flex h-5 w-10 flex-shrink-0 cursor-pointer items-center justify-center rounded-full pt-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                          >
                            <span
                              aria-hidden="true"
                              className={`${
                                isAllUsers() ? 'bg-indigo-500' : 'bg-gray-800'
                              } absolute mx-auto h-4 w-9 rounded-full transition-colors duration-200 ease-in-out`}
                            />
                            <span
                              aria-hidden="true"
                              className={`${
                                isAllUsers() ? 'translate-x-5' : 'translate-x-0'
                              } absolute left-0 inline-block h-5 w-5 rounded-full border border-gray-200 bg-white shadow transition-transform duration-200 ease-in-out group-focus:border-blue-300 group-focus:ring`}
                            />
                          </span>
                        </th>
                        <th className="bg-gray-500 px-1 py-3 text-left text-xs font-medium uppercase leading-4 tracking-wider text-gray-200 md:px-6">
                          {intl.formatMessage(messages.user)}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-700 bg-gray-600">
                      {data?.map((user) => (
                        <tr key={`user-${user.id}`}>
                          <td className="whitespace-nowrap px-4 py-4 text-sm font-medium leading-5 text-gray-100">
                            <span
                              role="checkbox"
                              tabIndex={0}
                              aria-checked={isSelectedUser(user.id)}
                              aria-label={user.username}
                              onClick={() => toggleUser(user.id)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  toggleUser(user.id);
                                }
                              }}
                              className="relative inline-flex h-5 w-10 flex-shrink-0 cursor-pointer items-center justify-center rounded-full pt-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                            >
                              <span
                                aria-hidden="true"
                                className={`${
                                  isSelectedUser(user.id)
                                    ? 'bg-indigo-500'
                                    : 'bg-gray-800'
                                } absolute mx-auto h-4 w-9 rounded-full transition-colors duration-200 ease-in-out`}
                              />
                              <span
                                aria-hidden="true"
                                className={`${
                                  isSelectedUser(user.id)
                                    ? 'translate-x-5'
                                    : 'translate-x-0'
                                } absolute left-0 inline-block h-5 w-5 rounded-full border border-gray-200 bg-white shadow transition-transform duration-200 ease-in-out group-focus:border-blue-300 group-focus:ring`}
                              />
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-1 py-4 text-sm font-medium leading-5 text-gray-100 md:px-6">
                            <div className="flex items-center">
                              <Image
                                className="h-10 w-10 flex-shrink-0 rounded-full"
                                src={user.thumb}
                                alt=""
                                width={40}
                                height={40}
                              />
                              <div className="ml-4">
                                <div className="text-base font-bold leading-5">
                                  {user.username}
                                </div>
                                {user.username &&
                                  user.username.toLowerCase() !==
                                    user.email && (
                                    <div className="text-sm leading-5 text-gray-300">
                                      {user.email}
                                    </div>
                                  )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </>
      ) : (
        <Alert title={intl.formatMessage(messages.nouserstoimport)} type="info">
          {intl.formatMessage(messages.syncnotice)}
        </Alert>
      )}
    </Modal>
  );
};

export default PlexImportModal;
