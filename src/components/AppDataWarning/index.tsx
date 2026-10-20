import Alert from '@app/components/Common/Alert';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.AppDataWarning', {
  dockerVolumeMissingDescription:
    '<code>{appDataPath}</code> isn’t a mounted volume, so all data is lost when the container restarts.',
});

const AppDataWarning = () => {
  const intl = useIntl();
  const { data, error } = useSWR<{ appData: boolean; appDataPath: string }>(
    '/api/v1/status/appdata'
  );

  if (!data && !error) {
    return null;
  }

  if (!data) {
    return null;
  }

  return (
    <>
      {!data.appData && (
        <Alert
          title={intl.formatMessage(messages.dockerVolumeMissingDescription, {
            code: (msg: React.ReactNode) => (
              <code className="bg-gray-800/50">{msg}</code>
            ),
            appDataPath: data.appDataPath,
          })}
        />
      )}
    </>
  );
};

export default AppDataWarning;
