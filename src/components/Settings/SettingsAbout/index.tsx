import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import List from '@app/components/Common/List';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import Releases from '@app/components/Settings/SettingsAbout/Releases';
import useSettings from '@app/hooks/useSettings';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import {
  PROJECT_DEV_BRANCH,
  PROJECT_DOCS_URL,
  PROJECT_URL,
} from '@server/constants/project';
import type {
  SettingsAboutResponse,
  StatusResponse,
} from '@server/interfaces/api/settingsInterfaces';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Settings.SettingsAbout', {
  about: 'About',
  aboutseerr: 'About Seerr AI',
  version: 'Version',
  totalmedia: 'Total Media',
  totalrequests: 'Total Requests',
  gettingsupport: 'Getting Support',
  githubIssues: 'Problems and Ideas',
  seerrAiGuide: 'The Seerr AI guide',
  seerrDocumentation: 'Seerr Documentation',
  timezone: 'Time Zone',
  appDataPath: 'Data Directory',
  supportseerr: 'Support Seerr, which Seerr AI is built on',
  contribute: 'Make a Contribution',
  documentation: 'Documentation',
  outofdate: 'Out of Date',
  uptodate: 'Up to Date',
  versionCheckDisabled: 'Version Check Disabled',
  runningDevelop:
    'You are running the <code>develop</code> branch of Seerr AI, which is only recommended for those contributing to development or assisting with bleeding-edge testing.',
});

const SettingsAbout = () => {
  const settings = useSettings();
  const intl = useIntl();
  const { data, error } = useSWR<SettingsAboutResponse>(
    '/api/v1/settings/about'
  );

  const { data: status } = useSWR<StatusResponse>(
    settings.currentSettings.versionCheck ? '/api/v1/status' : null
  );

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return <ErrorPage statusCode={500} />;
  }

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.about),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <div className="section">
        <List title={intl.formatMessage(messages.aboutseerr)}>
          {data.version.startsWith('develop-') && (
            <Alert
              title={intl.formatMessage(messages.runningDevelop, {
                code: (msg: React.ReactNode) => (
                  <code className="bg-gray-800/50">{msg}</code>
                ),
              })}
            />
          )}
          <List.Item
            title={intl.formatMessage(messages.version)}
            className="flex flex-row items-center truncate"
          >
            <code className="truncate">
              {data.version.replace('develop-', '')}
            </code>
            {settings.currentSettings.versionCheck ? (
              status && status.commitTag !== 'local' ? (
                status.updateAvailable ? (
                  <a
                    href={
                      data.version.startsWith('develop-')
                        ? `${PROJECT_URL}/compare/${status.commitTag}...${PROJECT_DEV_BRANCH}`
                        : `${PROJECT_URL}/releases`
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Badge
                      badgeType="warning"
                      className="ml-2 !cursor-pointer transition hover:bg-yellow-400"
                    >
                      {intl.formatMessage(messages.outofdate)}
                    </Badge>
                  </a>
                ) : (
                  <a
                    href={
                      data.version.startsWith('develop-')
                        ? `${PROJECT_URL}/commits/${PROJECT_DEV_BRANCH}`
                        : `${PROJECT_URL}/releases`
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Badge
                      badgeType="success"
                      className="ml-2 !cursor-pointer transition hover:bg-green-400"
                    >
                      {intl.formatMessage(messages.uptodate)}
                    </Badge>
                  </a>
                )
              ) : null
            ) : (
              <a
                href={
                  data.version.startsWith('develop-')
                    ? `${PROJECT_URL}/commits/${PROJECT_DEV_BRANCH}`
                    : `${PROJECT_URL}/releases`
                }
                target="_blank"
                rel="noopener noreferrer"
              >
                <Badge
                  badgeType="primary"
                  className="ml-2 !cursor-pointer transition hover:bg-yellow-400"
                >
                  {intl.formatMessage(messages.versionCheckDisabled)}
                </Badge>
              </a>
            )}
          </List.Item>
          <List.Item title={intl.formatMessage(messages.totalmedia)}>
            {intl.formatNumber(data.totalMediaItems)}
          </List.Item>
          <List.Item title={intl.formatMessage(messages.totalrequests)}>
            {intl.formatNumber(data.totalRequests)}
          </List.Item>
          <List.Item title={intl.formatMessage(messages.appDataPath)}>
            <code>{data.appDataPath}</code>
          </List.Item>
          {data.tz && (
            <List.Item title={intl.formatMessage(messages.timezone)}>
              <code>{data.tz}</code>
            </List.Item>
          )}
        </List>
      </div>
      <div className="section">
        <List title={intl.formatMessage(messages.gettingsupport)}>
          <List.Item title={intl.formatMessage(messages.documentation)}>
            <a
              href={PROJECT_DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="text-indigo-500 transition duration-300 hover:underline"
            >
              {intl.formatMessage(messages.seerrAiGuide)}
            </a>
          </List.Item>
          <List.Item title={intl.formatMessage(messages.seerrDocumentation)}>
            <a
              href="https://docs.seerr.dev"
              target="_blank"
              rel="noreferrer"
              className="text-indigo-500 transition duration-300 hover:underline"
            >
              https://docs.seerr.dev
            </a>
          </List.Item>
          <List.Item title={intl.formatMessage(messages.githubIssues)}>
            <a
              href={`${PROJECT_URL}/issues`}
              target="_blank"
              rel="noreferrer"
              className="text-indigo-500 transition duration-300 hover:underline"
            >
              {`${PROJECT_URL}/issues`}
            </a>
          </List.Item>
        </List>
      </div>
      <div className="section">
        <List title={intl.formatMessage(messages.supportseerr)}>
          <List.Item title={intl.formatMessage(messages.contribute)}>
            <a
              href="https://opencollective.com/seerr"
              target="_blank"
              rel="noreferrer"
              className="text-indigo-500 transition duration-300 hover:underline"
            >
              https://opencollective.com/seerr
            </a>
          </List.Item>
        </List>
      </div>
      <div className="section">
        <Releases currentVersion={data.version} />
      </div>
    </>
  );
};

export default SettingsAbout;
