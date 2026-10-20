import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import { SmallLoadingSpinner } from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import LibraryItem from '@app/components/Settings/LibraryItem';
import {
  MusicLibrariesOff,
  musicLibrariesKey,
  useMusicLibraries,
} from '@app/components/Settings/MusicLibraries';
import { SERVER_NAMES } from '@app/components/Settings/SettingsMediaServers/names';
import usePlexLogin from '@app/hooks/usePlexLogin';
import defineMessages from '@app/utils/defineMessages';
import { ArrowPathIcon } from '@heroicons/react/24/solid';
import type {
  MediaServerAdmin,
  MediaServerSummary,
} from '@server/interfaces/api/mediaServerInterfaces';
import type { PlexDevice } from '@server/interfaces/api/plexInterfaces';
import type { Library, MusicLibrary } from '@server/lib/settings';
import axios from 'axios';
import { useEffect, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import { mutate } from 'swr';

/*
 * Connecting a media server from Settings → Media Servers, loaded only when
 * Connect is pressed. Plex: the owner signs in with Plex, then picks one of
 * their servers. Jellyfin and Emby: the address, then an administrator's
 * sign-in or an API key. Then, for any of them, the libraries it has, found
 * there and then: films and series, and music (while music is on), each to
 * switch on or off before the dialog is closed.
 */

const messages = defineMessages(
  'components.Settings.SettingsMediaServers.ConnectModal',
  {
    connectTitle: 'Connect {server}',
    plexOwnerOnly:
      'Only the owner of this Seerr AI can connect Plex: Seerr AI reaches Plex through their Plex account.',
    plexSignInDescription:
      'Sign in with the Plex account that owns the server. It is linked to your account here, and Seerr AI reaches Plex with it. Your email address here stays as it is.',
    plexSignIn: 'Sign In with Plex',
    plexSigningIn: 'Signing In…',
    plexContinueAs: 'Continue as {name}',
    plexSignedInAs: 'Signed in to Plex as {name}.',
    plexSignInFailed: 'Signing in with Plex did not work. Try again.',
    plexAccountTaken:
      'That Plex account is already linked to someone else here.',
    server: 'Server',
    loadingServers: 'Finding your Plex servers…',
    noServers:
      'No Plex servers owned by this account were found. Enter the address by hand.',
    serverOption:
      '{name} ({address}) [{where, select, local {local} other {remote}}]{secure, select, yes { [secure]} other {}}',
    manual: 'Enter the address by hand',
    hostname: 'Hostname or IP Address',
    port: 'Port',
    useSsl: 'Use SSL',
    urlBase: 'URL Base',
    externalUrl: 'External URL',
    externalUrlTip: 'The address people use, for Play links',
    howToConnect: 'Connect with',
    adminLogin: "An administrator's sign-in",
    adminLoginTip: 'Seerr AI makes itself an API key with it',
    apiKeyOption: 'An API key',
    username: 'Username',
    password: 'Password',
    apiKey: 'API Key',
    findAdmins: 'Find Administrators',
    admin: 'Administrator',
    adminTip: 'The account Seerr AI reads libraries as',
    noAdmins: 'No administrators were found with that API key.',
    myAccount: 'This is my account',
    myAccountTip:
      'Links it to your account here, so you can sign in with it too',
    allowSignIn: 'Allow sign-in with {server}',
    allowSignInTip: 'People can sign in with their {server} account',
    connect: 'Connect',
    connecting: 'Connecting…',
    librariesDescription:
      'Choose the libraries Seerr AI scans for titles. They can be changed later from Edit.',
    filmsAndSeries: 'Films and Series',
    music: 'Music',
    noneFound: 'None were found.',
    syncingLibraries: 'Finding libraries…',
    librariesFailed:
      'The libraries could not be listed. Try again, or choose them later from Edit.',
    retry: 'Try Again',
    done: 'Done',
    doneTip:
      'The libraries you turn on are scanned now, and then every night and as titles are added.',
    errorUnreachable:
      'Could not reach the server. Check the address, and that it is running.',
    errorCredentials: 'The username or password is wrong.',
    errorApiKey: 'The server did not accept that API key.',
    errorNotAdmin: 'That account is not an administrator on {server}.',
    errorConflict:
      'That account is already linked to someone else here, or this server is already connected as another kind.',
    errorUnknown: 'Something went wrong connecting {server}.',
  }
);

interface ConnectModalProps {
  server: MediaServerSummary;
  /** The signed-in person is the owner (user 1). */
  isOwner: boolean;
  onClose: () => void;
}

type Step = 'account' | 'server' | 'libraries';

const ConnectModal = ({ server, isOwner, onClose }: ConnectModalProps) => {
  const intl = useIntl();
  const kind = server.kind;
  const name = SERVER_NAMES[kind];
  const isPlex = kind === 'plex';

  const [step, setStep] = useState<Step>(isPlex ? 'account' : 'server');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  // Plex
  const [plexAccount, setPlexAccount] = useState(server.ownerAccount);
  const [devices, setDevices] = useState<PlexDevice[]>();

  // The address, as Seerr last reached the server when it has been before.
  const [hostname, setHostname] = useState(server.address.ip ?? '');
  const [port, setPort] = useState(
    String(server.address.port || (isPlex ? 32400 : 8096))
  );
  const [useSsl, setUseSsl] = useState(!!server.address.useSsl);
  const [urlBase, setUrlBase] = useState(server.address.urlBase ?? '');
  const [externalUrl, setExternalUrl] = useState(
    server.address.externalHostname ?? ''
  );

  // Jellyfin and Emby
  const [method, setMethod] = useState<'login' | 'apiKey'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [admins, setAdmins] = useState<MediaServerAdmin[]>();
  const [adminUserId, setAdminUserId] = useState('');
  const [linkOwner, setLinkOwner] = useState(isOwner && !server.ownerAccount);

  const [signIn, setSignIn] = useState(server.signIn);

  const [libraries, setLibraries] = useState<Library[]>();
  const [librariesFailed, setLibrariesFailed] = useState(false);

  const settingsEndpoint = `/api/v1/settings/${kind}`;
  // Read once the libraries have been synced, below.
  const music = useMusicLibraries(settingsEndpoint, !!libraries);

  const errorFor = (e: unknown): string => {
    const response = (
      e as { response?: { status?: number; data?: { message?: string } } }
    )?.response;
    const status = response?.status;
    const code = response?.data?.message;
    if (code === 'NOT_ADMIN') {
      return intl.formatMessage(messages.errorNotAdmin, { server: name });
    }
    if (status === 401) {
      return intl.formatMessage(
        method === 'apiKey' && !isPlex
          ? messages.errorApiKey
          : messages.errorCredentials
      );
    }
    if (status === 409) {
      return intl.formatMessage(messages.errorConflict);
    }
    if (status === 502 || status === 404 || code === 'INVALID_URL') {
      return intl.formatMessage(messages.errorUnreachable);
    }
    return intl.formatMessage(messages.errorUnknown, { server: name });
  };

  // Signing in to Plex: in a window, or in this tab, coming back to this
  // dialog (Settings → Media Servers opens it again), then linking the
  // account it gave.
  const plexLogin = usePlexLogin({
    purpose: 'connect',
    enabled: isPlex,
    onAuthToken: (authToken) => linkPlexOwner(authToken),
    onError: (message) => setError(message),
  });

  const linkPlexOwner = async (authToken: string) => {
    setError(undefined);
    setBusy(true);
    try {
      const res = await axios.post<{ plexUsername: string }>(
        '/api/v1/settings/media-servers/plex/account',
        { authToken }
      );
      setPlexAccount(res.data.plexUsername);
      setStep('server');
    } catch (e) {
      setError(
        intl.formatMessage(
          (e as { response?: { status?: number } })?.response?.status === 409
            ? messages.plexAccountTaken
            : messages.plexSignInFailed
        )
      );
    } finally {
      setBusy(false);
    }
  };

  // The owner's Plex servers, once signed in.
  useEffect(() => {
    if (!isPlex || step !== 'server' || devices) return;
    let active = true;
    axios
      .get<PlexDevice[]>('/api/v1/settings/plex/devices/servers')
      .then((res) => active && setDevices(res.data ?? []))
      .catch(() => active && setDevices([]));
    return () => {
      active = false;
    };
  }, [isPlex, step, devices]);

  const presets = useMemo(
    () =>
      (devices ?? []).flatMap((device) =>
        device.connection
          .filter((connection) => connection.status === 200)
          .map((connection) => ({
            name: device.name,
            address: connection.address,
            port: connection.port,
            ssl: connection.protocol === 'https',
            local: connection.local,
          }))
      ),
    [devices]
  );

  const findAdmins = async () => {
    setError(undefined);
    setBusy(true);
    try {
      const res = await axios.post<MediaServerAdmin[]>(
        `/api/v1/settings/media-servers/${kind}/admins`,
        { hostname, port: Number(port), useSsl, urlBase, apiKey }
      );
      setAdmins(res.data);
      setAdminUserId(res.data[0]?.id ?? '');
    } catch (e) {
      setAdmins(undefined);
      setError(errorFor(e));
    } finally {
      setBusy(false);
    }
  };

  const syncLibraries = async () => {
    setLibrariesFailed(false);
    setLibraries(undefined);
    try {
      // Lists every library the server has now, music ones included.
      const res = await axios.post<Library[]>(
        `${settingsEndpoint}/library/sync`
      );
      // The music ones as this sync found them, not as last seen.
      if (music.ready) {
        const key = musicLibrariesKey(settingsEndpoint);
        await mutate(
          key,
          axios.get<MusicLibrary[]>(key).then((r) => r.data),
          { revalidate: false }
        ).catch(() => mutate(key, undefined, { revalidate: false }));
      }
      setLibraries(res.data);
    } catch {
      setLibrariesFailed(true);
    }
  };

  const connect = async () => {
    setError(undefined);
    setBusy(true);
    try {
      await axios.post(`/api/v1/settings/media-servers/${kind}/connect`, {
        hostname,
        port: Number(port),
        useSsl,
        signIn,
        ...(isPlex
          ? {}
          : {
              urlBase,
              externalHostname: externalUrl,
              linkOwner: isOwner && linkOwner,
              ...(method === 'login'
                ? { username, password }
                : { apiKey, adminUserId }),
            }),
      });
      setStep('libraries');
      syncLibraries();
    } catch (e) {
      setError(errorFor(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleLibrary = async (library: Library) => {
    try {
      await axios.put(`${settingsEndpoint}/library/${library.id}`, {
        enabled: !library.enabled,
      });
      setLibraries((current) =>
        current?.map((l) =>
          l.id === library.id ? { ...l, enabled: !l.enabled } : l
        )
      );
    } catch {
      setLibrariesFailed(true);
    }
  };

  const finish = async () => {
    if (libraries?.some((library) => library.enabled)) {
      await axios
        .post(`${settingsEndpoint}/sync`, { start: true })
        .catch(() => undefined);
    }
    onClose();
  };

  const canConnect =
    !!hostname &&
    !!Number(port) &&
    (isPlex || (method === 'login' ? !!username : !!apiKey && !!adminUserId));

  const title = intl.formatMessage(messages.connectTitle, { server: name });

  if (step === 'libraries') {
    return (
      <Modal
        title={title}
        onOk={() => finish()}
        okText={intl.formatMessage(messages.done)}
        backgroundClickable={false}
      >
        <p className="mb-4">
          {intl.formatMessage(messages.librariesDescription)}
        </p>
        {librariesFailed ? (
          <div>
            <Alert
              type="warning"
              title={intl.formatMessage(messages.librariesFailed)}
            />
            <Button onClick={() => syncLibraries()}>
              <ArrowPathIcon />
              <span>{intl.formatMessage(messages.retry)}</span>
            </Button>
          </div>
        ) : !libraries ? (
          <div className="flex items-center gap-2 text-gray-300">
            <SmallLoadingSpinner />
            <span>{intl.formatMessage(messages.syncingLibraries)}</span>
          </div>
        ) : (
          <div className="space-y-6">
            <section aria-labelledby="connect-libraries-video">
              <h4
                id="connect-libraries-video"
                className="mb-3 font-medium text-strong"
              >
                {intl.formatMessage(messages.filmsAndSeries)}
              </h4>
              {libraries.length === 0 ? (
                <p className="text-sm text-gray-400">
                  {intl.formatMessage(messages.noneFound)}
                </p>
              ) : (
                <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {libraries.map((library) => (
                    <LibraryItem
                      key={library.id}
                      name={library.name}
                      isEnabled={library.enabled}
                      onToggle={() => toggleLibrary(library)}
                    />
                  ))}
                </ul>
              )}
            </section>
            <section aria-labelledby="connect-libraries-music">
              <h4
                id="connect-libraries-music"
                className="mb-3 font-medium text-strong"
              >
                {intl.formatMessage(messages.music)}
              </h4>
              {!music.ready ? (
                <MusicLibrariesOff linked />
              ) : !music.data ? (
                <div className="flex items-center gap-2 text-gray-300">
                  <SmallLoadingSpinner />
                  <span>{intl.formatMessage(messages.syncingLibraries)}</span>
                </div>
              ) : music.data.length === 0 ? (
                <p className="text-sm text-gray-400">
                  {intl.formatMessage(messages.noneFound)}
                </p>
              ) : (
                <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {music.data.map((library) => (
                    <LibraryItem
                      key={library.id}
                      name={library.name}
                      isEnabled={library.enabled}
                      onToggle={() => music.toggle(library)}
                    />
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
        <p className="mt-4 text-sm text-gray-400">
          {intl.formatMessage(messages.doneTip)}
        </p>
      </Modal>
    );
  }

  if (step === 'account') {
    return (
      <Modal title={title} onCancel={onClose}>
        {!isOwner ? (
          <p>{intl.formatMessage(messages.plexOwnerOnly)}</p>
        ) : (
          <>
            <p>{intl.formatMessage(messages.plexSignInDescription)}</p>
            {error && (
              <div className="mt-4">
                <Alert type="error" title={error} />
              </div>
            )}
            <div className="mt-6 flex flex-wrap gap-3">
              <Button
                buttonType="primary"
                disabled={busy || plexLogin.loading}
                onClick={() => {
                  setError(undefined);
                  plexLogin.login();
                }}
              >
                <span>
                  {intl.formatMessage(
                    busy || plexLogin.loading
                      ? messages.plexSigningIn
                      : messages.plexSignIn
                  )}
                </span>
              </Button>
              {plexAccount && (
                <Button
                  disabled={busy || plexLogin.loading}
                  onClick={() => setStep('server')}
                >
                  <span>
                    {intl.formatMessage(messages.plexContinueAs, {
                      name: plexAccount,
                    })}
                  </span>
                </Button>
              )}
            </div>
          </>
        )}
      </Modal>
    );
  }

  return (
    <Modal
      title={title}
      onCancel={onClose}
      onOk={() => connect()}
      okText={intl.formatMessage(busy ? messages.connecting : messages.connect)}
      okDisabled={busy || !canConnect}
      backgroundClickable={false}
    >
      {isPlex && plexAccount && (
        <p className="mb-4 text-sm text-gray-300">
          {intl.formatMessage(messages.plexSignedInAs, { name: plexAccount })}
        </p>
      )}
      {error && (
        <div className="mb-4">
          <Alert type="error" title={error} />
        </div>
      )}
      {isPlex && (
        <div className="form-row">
          <label htmlFor="connect-preset" className="text-label">
            {intl.formatMessage(messages.server)}
          </label>
          <div className="form-input-area">
            <div className="form-input-field">
              <select
                id="connect-preset"
                disabled={!devices}
                defaultValue=""
                onChange={(e) => {
                  const preset = presets[Number(e.target.value)];
                  if (preset) {
                    setHostname(preset.address);
                    setPort(String(preset.port));
                    setUseSsl(preset.ssl);
                  }
                }}
              >
                <option value="">
                  {intl.formatMessage(
                    !devices
                      ? messages.loadingServers
                      : presets.length
                        ? messages.manual
                        : messages.noServers
                  )}
                </option>
                {presets.map((preset, index) => (
                  <option key={`${preset.address}-${index}`} value={index}>
                    {intl.formatMessage(messages.serverOption, {
                      name: preset.name,
                      address: preset.address,
                      where: preset.local ? 'local' : 'remote',
                      secure: preset.ssl ? 'yes' : 'no',
                    })}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      )}
      <div className="form-row">
        <label htmlFor="connect-hostname" className="text-label">
          {intl.formatMessage(messages.hostname)}
          <span className="label-required">*</span>
        </label>
        <div className="form-input-area">
          <div className="form-input-field">
            <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-gray-100 sm:text-sm">
              {useSsl ? 'https://' : 'http://'}
            </span>
            <input
              id="connect-hostname"
              type="text"
              inputMode="url"
              className="rounded-r-only"
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
            />
          </div>
        </div>
      </div>
      <div className="form-row">
        <label htmlFor="connect-port" className="text-label">
          {intl.formatMessage(messages.port)}
          <span className="label-required">*</span>
        </label>
        <div className="form-input-area">
          <input
            id="connect-port"
            type="text"
            inputMode="numeric"
            className="short"
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
        </div>
      </div>
      <div className="form-row">
        <label htmlFor="connect-ssl" className="checkbox-label">
          {intl.formatMessage(messages.useSsl)}
        </label>
        <div className="form-input-area">
          <input
            id="connect-ssl"
            type="checkbox"
            checked={useSsl}
            onChange={() => setUseSsl(!useSsl)}
          />
        </div>
      </div>
      {!isPlex && (
        <>
          <div className="form-row">
            <label htmlFor="connect-urlbase" className="text-label">
              {intl.formatMessage(messages.urlBase)}
            </label>
            <div className="form-input-area">
              <div className="form-input-field">
                <input
                  id="connect-urlbase"
                  type="text"
                  inputMode="url"
                  value={urlBase}
                  onChange={(e) => setUrlBase(e.target.value)}
                />
              </div>
            </div>
          </div>
          <div className="form-row">
            <label htmlFor="connect-external" className="text-label">
              {intl.formatMessage(messages.externalUrl)}
              <span className="label-tip">
                {intl.formatMessage(messages.externalUrlTip)}
              </span>
            </label>
            <div className="form-input-area">
              <div className="form-input-field">
                <input
                  id="connect-external"
                  type="text"
                  inputMode="url"
                  value={externalUrl}
                  onChange={(e) => setExternalUrl(e.target.value)}
                />
              </div>
            </div>
          </div>
          <div
            role="group"
            aria-labelledby="connect-method"
            className="form-row"
          >
            <span id="connect-method" className="group-label">
              {intl.formatMessage(messages.howToConnect)}
            </span>
            <div className="form-input-area space-y-2">
              <label className="flex items-start gap-2">
                <input
                  type="radio"
                  name="connect-method"
                  checked={method === 'login'}
                  onChange={() => setMethod('login')}
                />
                <span>
                  {intl.formatMessage(messages.adminLogin)}
                  <span className="block text-sm text-gray-400">
                    {intl.formatMessage(messages.adminLoginTip)}
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input
                  type="radio"
                  name="connect-method"
                  checked={method === 'apiKey'}
                  onChange={() => setMethod('apiKey')}
                />
                <span>{intl.formatMessage(messages.apiKeyOption)}</span>
              </label>
            </div>
          </div>
          {method === 'login' ? (
            <>
              <div className="form-row">
                <label htmlFor="connect-username" className="text-label">
                  {intl.formatMessage(messages.username)}
                  <span className="label-required">*</span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <input
                      id="connect-username"
                      type="text"
                      autoComplete="off"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                    />
                  </div>
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="connect-password" className="text-label">
                  {intl.formatMessage(messages.password)}
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <input
                      id="connect-password"
                      type="password"
                      autoComplete="off"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </div>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="form-row">
                <label htmlFor="connect-apikey" className="text-label">
                  {intl.formatMessage(messages.apiKey)}
                  <span className="label-required">*</span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <input
                      id="connect-apikey"
                      type="text"
                      autoComplete="off"
                      className="rounded-l-only"
                      value={apiKey}
                      onChange={(e) => {
                        setApiKey(e.target.value);
                        setAdmins(undefined);
                        setAdminUserId('');
                      }}
                    />
                    <Button
                      type="button"
                      className="rounded-l-none"
                      disabled={busy || !hostname || !apiKey}
                      onClick={() => findAdmins()}
                    >
                      {intl.formatMessage(messages.findAdmins)}
                    </Button>
                  </div>
                </div>
              </div>
              {admins && (
                <div className="form-row">
                  <label htmlFor="connect-admin" className="text-label">
                    {intl.formatMessage(messages.admin)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.adminTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    {admins.length ? (
                      <div className="form-input-field">
                        <select
                          id="connect-admin"
                          value={adminUserId}
                          onChange={(e) => setAdminUserId(e.target.value)}
                        >
                          {admins.map((admin) => (
                            <option key={admin.id} value={admin.id}>
                              {admin.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : (
                      <p className="text-sm text-gray-300">
                        {intl.formatMessage(messages.noAdmins)}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
          {isOwner && (
            <div className="form-row">
              <label htmlFor="connect-mine" className="checkbox-label">
                {intl.formatMessage(messages.myAccount)}
                <span className="label-tip">
                  {intl.formatMessage(messages.myAccountTip)}
                </span>
              </label>
              <div className="form-input-area">
                <input
                  id="connect-mine"
                  type="checkbox"
                  checked={linkOwner}
                  onChange={() => setLinkOwner(!linkOwner)}
                />
              </div>
            </div>
          )}
        </>
      )}
      <div className="form-row">
        <label htmlFor="connect-signin" className="checkbox-label">
          {intl.formatMessage(messages.allowSignIn, { server: name })}
          <span className="label-tip">
            {intl.formatMessage(messages.allowSignInTip, { server: name })}
          </span>
        </label>
        <div className="form-input-area">
          <input
            id="connect-signin"
            type="checkbox"
            checked={signIn}
            onChange={() => setSignIn(!signIn)}
          />
        </div>
      </div>
    </Modal>
  );
};

export default ConnectModal;
