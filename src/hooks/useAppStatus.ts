import useSettings from '@app/hooks/useSettings';
import { Permission, useUser } from '@app/hooks/useUser';
import type { StatusResponse } from '@server/interfaces/api/settingsInterfaces';
import useSWR from 'swr';

/** Whether an SWR key is the app status, in any of its forms. */
export const isStatusKey = (key: unknown): boolean =>
  typeof key === 'string' && key.startsWith('/api/v1/status?');

/**
 * The server's version, which the update prompt watches, and for admins with
 * version checks on whether an update is out, which the sidebar shows. One
 * request serves both.
 */
const useAppStatus = () => {
  const { currentSettings } = useSettings();
  const { hasPermission } = useUser();
  const checkUpdate =
    currentSettings.versionCheck && hasPermission(Permission.ADMIN);
  return useSWR<StatusResponse>(
    `/api/v1/status?checkUpdateAvailable=${checkUpdate}`,
    { refreshInterval: 60 * 1000 }
  );
};

export default useAppStatus;
