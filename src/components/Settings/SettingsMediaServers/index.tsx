import EmbyLogo from '@app/assets/services/emby-icon-only.svg';
import JellyfinLogo from '@app/assets/services/jellyfin-icon.svg';
import PlexLogo from '@app/assets/services/plex.svg';
import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import PageTitle from '@app/components/Common/PageTitle';
import SlideCheckbox from '@app/components/Common/SlideCheckbox';
import CardFooter from '@app/components/Settings/CardFooter';
import { SERVER_NAMES } from '@app/components/Settings/SettingsMediaServers/names';
import useLazyModule, { preloadModule } from '@app/hooks/useLazyModule';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { hasPlexReturn } from '@app/utils/plexSameTab';
import { Transition } from '@headlessui/react';
import {
  ArrowPathIcon,
  LinkIcon,
  PencilIcon,
  StarIcon,
  TrashIcon,
} from '@heroicons/react/24/solid';
import type { MediaServerKind } from '@server/constants/server';
import type {
  MediaServerRemovalImpact,
  MediaServerSummary,
} from '@server/interfaces/api/mediaServerInterfaces';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';

const messages = defineMessages('components.Settings.SettingsMediaServers', {
  mediaServers: 'Media Servers',
  mediaServersDescription:
    'Connect any mix of Plex, Jellyfin and Emby. A title is available if any of them has it.',
  primary: 'Primary',
  notConnected: 'Not connected',
  libraries:
    '{enabled, plural, =0 {No libraries enabled} one {# library enabled} other {# libraries enabled}}',
  lastScan: 'Last scanned {date}',
  neverScanned: 'Not scanned yet',
  allowSignIn: 'Allow sign-in with {server}',
  connect: 'Connect',
  makePrimary: 'Make Primary',
  remove: 'Remove',
  lastServer:
    'Seerr AI needs at least one media server: connect another before removing this one.',
  removeTitle: 'Remove {server}?',
  removeDescription:
    'Seerr AI stops scanning {server} and drops its Play links. Its settings are kept for a quick reconnect.',
  removePrimary: '{next} becomes the primary server.',
  removePasswordOnly:
    '{count, plural, one {# person} other {# people}} could then sign in only with a password.',
  removeNoSignIn:
    '{count, plural, one {# person} other {# people}} could then not sign in at all.',
  removeNobody: 'Everyone with an account on it can still sign in another way.',
  removeAccounts:
    "People's {server} accounts stay linked, and are used again if {server} is connected again.",
  removing: 'Removing…',
  removed: '{server} was removed.',
  removeFailed: 'Something went wrong removing {server}.',
  primaryChanged: '{server} is now the primary server.',
  changeFailed: 'Something went wrong saving that.',
  signInFailedLast:
    'At least one way to sign in must stay on. Turn on password or another server’s sign-in first.',
  couldNotOpen:
    'That could not be opened. Check your connection and try again.',
  loadFailed: 'The media servers could not be loaded.',
});

const LOGOS: Record<
  MediaServerKind,
  React.FC<React.SVGProps<SVGSVGElement>>
> = {
  plex: PlexLogo,
  jellyfin: JellyfinLogo,
  emby: EmbyLogo,
};

const ENDPOINT = '/api/v1/settings/media-servers';

const loadConnect = () =>
  import('@app/components/Settings/SettingsMediaServers/ConnectModal');

/** A dialog that fades in and out. */
const Fade = ({
  show,
  children,
}: {
  show: boolean;
  children: React.ReactNode;
}) => (
  <Transition
    as="div"
    show={show}
    enter="transition-opacity duration-300"
    enterFrom="opacity-0"
    enterTo="opacity-100"
    leave="transition-opacity duration-300"
    leaveFrom="opacity-100"
    leaveTo="opacity-0"
  >
    {children}
  </Transition>
);

const SettingsMediaServers = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { user } = useUser();
  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<MediaServerSummary[]>(ENDPOINT);
  const [connecting, setConnecting] = useState<MediaServerKind>();
  const [removing, setRemoving] = useState<MediaServerKind>();
  // Undefined while being counted; null when it could not be.
  const [impact, setImpact] = useState<MediaServerRemovalImpact | null>();
  const [busy, setBusy] = useState(false);

  useEffect(() => preloadModule(loadConnect), []);

  // Back from signing in to Plex in this tab, to connect it (the Plex
  // window could not open): the Connect dialog finishes that.
  useEffect(() => {
    if (hasPlexReturn('connect')) {
      setConnecting('plex');
    }
  }, []);

  const connectModule = useLazyModule(loadConnect, !!connecting, () => {
    addToast(intl.formatMessage(messages.couldNotOpen), {
      appearance: 'error',
      autoDismiss: true,
    });
    setConnecting(undefined);
  });

  useEffect(() => {
    setImpact(undefined);
    if (!removing) return;
    let active = true;
    axios
      .get<MediaServerRemovalImpact>(`${ENDPOINT}/${removing}/removal`)
      .then((res) => active && setImpact(res.data))
      .catch(() => active && setImpact(null));
    return () => {
      active = false;
    };
  }, [removing]);

  /** The list as a change left it, and what every page knows of it. */
  const changed = (list: MediaServerSummary[]) => {
    revalidate(list, { revalidate: false });
    mutate('/api/v1/settings/public');
  };

  const nameOf = (server: MediaServerSummary) => SERVER_NAMES[server.kind];

  const setSignIn = async (server: MediaServerSummary) => {
    try {
      const res = await axios.post<MediaServerSummary[]>(
        `${ENDPOINT}/${server.kind}/sign-in`,
        { signIn: !server.signIn }
      );
      changed(res.data);
    } catch (e) {
      addToast(
        intl.formatMessage(
          e?.response?.status === 400
            ? messages.signInFailedLast
            : messages.changeFailed
        ),
        { appearance: 'error', autoDismiss: true }
      );
    }
  };

  const makePrimary = async (server: MediaServerSummary) => {
    try {
      const res = await axios.post<MediaServerSummary[]>(
        `${ENDPOINT}/${server.kind}/primary`
      );
      changed(res.data);
      addToast(
        intl.formatMessage(messages.primaryChanged, {
          server: nameOf(server),
        }),
        { appearance: 'success', autoDismiss: true }
      );
    } catch {
      addToast(intl.formatMessage(messages.changeFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };

  const remove = async () => {
    if (!removing) return;
    const server = SERVER_NAMES[removing];
    setBusy(true);
    try {
      const res = await axios.delete<MediaServerSummary[]>(
        `${ENDPOINT}/${removing}`
      );
      changed(res.data);
      addToast(intl.formatMessage(messages.removed, { server }), {
        appearance: 'success',
        autoDismiss: true,
      });
      setRemoving(undefined);
    } catch {
      addToast(intl.formatMessage(messages.removeFailed, { server }), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setBusy(false);
    }
  };

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  const connectedCount = data?.filter((server) => server.connected).length;
  const removingServer = data?.find((server) => server.kind === removing);
  const nextPrimary = removingServer?.primary
    ? data?.find((server) => server.connected && server.kind !== removing)
    : undefined;
  const connectingServer = data?.find((server) => server.kind === connecting);

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.mediaServers),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.mediaServers)}</h3>
        <p className="description">
          {intl.formatMessage(messages.mediaServersDescription)}
        </p>
      </div>
      <div className="section">
        {error && !data && (
          <Alert type="error" title={intl.formatMessage(messages.loadFailed)}>
            <Button buttonSize="sm" onClick={() => revalidate()}>
              <ArrowPathIcon />
              <span>{intl.formatMessage(globalMessages.retry)}</span>
            </Button>
          </Alert>
        )}
        <ul className="grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-2 xl:grid-cols-3">
          {data?.map((server) => {
            const Logo = LOGOS[server.kind];
            const name = nameOf(server);
            return (
              <li
                key={server.kind}
                className={`col-span-1 flex flex-col rounded-lg shadow ring-1 ${
                  server.connected
                    ? 'bg-gray-800 ring-gray-500'
                    : 'bg-gray-900 ring-gray-700'
                }`}
              >
                <div className="flex flex-1 items-start justify-between space-x-4 p-6">
                  <div className="min-w-0 flex-1">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <h4 className="min-w-0 break-words font-medium leading-5 text-strong">
                        {name}
                      </h4>
                      {server.primary && (
                        <Badge badgeType="primary">
                          {intl.formatMessage(messages.primary)}
                        </Badge>
                      )}
                      {!server.connected && (
                        <Badge badgeType="dark">
                          {intl.formatMessage(messages.notConnected)}
                        </Badge>
                      )}
                    </div>
                    {server.connected && (
                      <>
                        {server.name && server.name !== name && (
                          <p className="break-words text-sm leading-5 text-gray-300">
                            {server.name}
                          </p>
                        )}
                        <p className="mt-1 text-sm leading-5 text-gray-300">
                          {intl.formatMessage(messages.libraries, {
                            enabled: server.enabledLibraries,
                          })}
                        </p>
                        <p className="mt-1 text-sm leading-5 text-gray-400">
                          {server.lastScan
                            ? intl.formatMessage(messages.lastScan, {
                                date: intl.formatDate(server.lastScan, {
                                  year: 'numeric',
                                  month: 'short',
                                  day: 'numeric',
                                  hour: 'numeric',
                                  minute: '2-digit',
                                }),
                              })
                            : intl.formatMessage(messages.neverScanned)}
                        </p>
                        <div className="mt-4 flex items-center gap-3">
                          <SlideCheckbox
                            checked={server.signIn}
                            label={intl.formatMessage(messages.allowSignIn, {
                              server: name,
                            })}
                            onClick={() => setSignIn(server)}
                          />
                          <span
                            className="text-sm text-gray-200"
                            aria-hidden="true"
                          >
                            {intl.formatMessage(messages.allowSignIn, {
                              server: name,
                            })}
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                  <Logo
                    aria-hidden="true"
                    className={`service-logo h-10 w-10 flex-shrink-0 ${
                      server.connected ? '' : 'opacity-40'
                    }`}
                  />
                </div>
                <CardFooter
                  room={3}
                  actions={
                    server.connected
                      ? [
                          {
                            label: intl.formatMessage(globalMessages.edit),
                            icon: PencilIcon,
                            href: `/settings/${server.kind}`,
                          },
                          ...(!server.primary
                            ? [
                                {
                                  label: intl.formatMessage(
                                    messages.makePrimary
                                  ),
                                  icon: StarIcon,
                                  onClick: () => makePrimary(server),
                                },
                              ]
                            : []),
                          {
                            label: intl.formatMessage(messages.remove),
                            icon: TrashIcon,
                            onClick: () => setRemoving(server.kind),
                            disabled: connectedCount === 1,
                            title:
                              connectedCount === 1
                                ? intl.formatMessage(messages.lastServer)
                                : undefined,
                          },
                        ]
                      : [
                          {
                            label: intl.formatMessage(messages.connect),
                            icon: LinkIcon,
                            onClick: () => setConnecting(server.kind),
                          },
                        ]
                  }
                />
              </li>
            );
          })}
        </ul>
      </div>

      <Fade show={!!removing}>
        {removingServer && (
          <Modal
            title={intl.formatMessage(messages.removeTitle, {
              server: nameOf(removingServer),
            })}
            onCancel={() => setRemoving(undefined)}
            onOk={() => remove()}
            okText={
              busy
                ? intl.formatMessage(messages.removing)
                : intl.formatMessage(messages.remove)
            }
            okButtonType="danger"
            okDisabled={busy || impact === undefined}
            loading={impact === undefined}
          >
            <p>
              {intl.formatMessage(messages.removeDescription, {
                server: nameOf(removingServer),
              })}
              {nextPrimary && (
                <>
                  {' '}
                  {intl.formatMessage(messages.removePrimary, {
                    next: nameOf(nextPrimary),
                  })}
                </>
              )}
            </p>
            {impact && (
              <div className="mt-4">
                {impact.passwordOnly || impact.noSignIn ? (
                  <Alert
                    type="warning"
                    title={[
                      impact.passwordOnly
                        ? intl.formatMessage(messages.removePasswordOnly, {
                            count: impact.passwordOnly,
                          })
                        : '',
                      impact.noSignIn
                        ? intl.formatMessage(messages.removeNoSignIn, {
                            count: impact.noSignIn,
                          })
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  />
                ) : (
                  <p>{intl.formatMessage(messages.removeNobody)}</p>
                )}
                <p className="mt-4 text-sm text-gray-400">
                  {intl.formatMessage(messages.removeAccounts, {
                    server: nameOf(removingServer),
                  })}
                </p>
              </div>
            )}
          </Modal>
        )}
      </Fade>

      <Fade show={!!connecting}>
        {connectModule && connectingServer && (
          <connectModule.default
            server={connectingServer}
            isOwner={user?.id === 1}
            onClose={() => {
              setConnecting(undefined);
              revalidate();
              mutate('/api/v1/settings/public');
            }}
          />
        )}
      </Fade>
    </>
  );
};

export default SettingsMediaServers;
