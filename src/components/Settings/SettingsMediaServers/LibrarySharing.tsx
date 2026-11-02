import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import {
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  MinusCircleIcon,
  PlusCircleIcon,
} from '@heroicons/react/24/outline';
import type { MediaServerKind } from '@server/constants/server';
import type {
  AccessBulkAction,
  AccessChangeView,
  AccessLibrary,
  AccessPlan,
  AccessResult,
  LibraryAccessView,
} from '@server/interfaces/api/libraryAccessInterfaces';
import axios from 'axios';
import Link from 'next/link';
import { useState } from 'react';
import { FormattedRelativeTime, useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.Settings.SettingsMediaServers.LibrarySharing',
  {
    librarySharing: 'Library Sharing',
    librarySharingDescription:
      'Who sees each library on your media servers. Take a library from everyone, or give it to everyone, in one go. You can change one person’s libraries on their own settings page.',
    sharedWith:
      'Shared with {count} of {total, plural, one {# person} other {# people}}',
    nobodyToShare: 'Not shared with anyone yet.',
    removeFromEveryone: 'Remove from everyone',
    shareWithEveryone: 'Share with everyone',
    removeTitle: 'Remove {library} from everyone?',
    shareTitle: 'Share {library} with everyone?',
    willLose:
      '{count, plural, one {# person loses it:} other {# people lose it:}}',
    willGet:
      '{count, plural, one {# person gets it:} other {# people get it:}}',
    nobodyChanges: 'Nobody would change.',
    fromAll:
      '{count, plural, one {# person had every library shared. They keep the others, but new libraries are no longer shared with them on their own.} other {# people had every library shared. They keep the others, but new libraries are no longer shared with them on their own.}}',
    emptied:
      'Left as they are, as it is their only library: {names}. Change them on their own page, or in {server}.',
    admins:
      '{count, plural, one {# administrator always sees every library.} other {# administrators always see every library.}}',
    oneTime:
      'This is done once, now. People added later are not changed. It can be undone below.',
    removeCount:
      '{count, plural, one {Remove from # person} other {Remove from # people}}',
    shareCount:
      '{count, plural, one {Share with # person} other {Share with # people}}',
    working: 'Changing…',
    removed:
      '{library} was removed from {count, plural, one {# person} other {# people}}.',
    shared:
      '{library} was shared with {count, plural, one {# more person} other {# more people}}.',
    someFailed:
      '{server} refused the change for {names}. Try again, or change them in {server}.',
    failed: 'Something went wrong: {detail}',
    loadFailed: '{server}’s libraries could not be read: {detail}',
    recentChanges: 'Recent Changes',
    noChanges: 'No changes made here yet.',
    historyRemove:
      'Removed {library} from {count, plural, one {# person} other {# people}}',
    historyAdd:
      'Shared {library} with {count, plural, one {# person} other {# people}}',
    historyPerson: 'Changed {name}’s libraries',
    historyFailed: '{count} refused',
    historyBy: 'by {name}',
    undo: 'Undo',
    undone: 'Undone',
    undoTitle: 'Undo this change?',
    undoDescription:
      'Each person gets back what they had before it. Anyone whose libraries were changed since is left as they are.',
    undoDone: 'Put back for {count, plural, one {# person} other {# people}}.',
    undoSkipped:
      '{count, plural, one {# person was changed since and was left as they are.} other {# people were changed since and were left as they are.}}',
    disabled: 'switched off',
    noLibraries: '{server} has no libraries.',
  }
);

const errorOf = (e: unknown) =>
  (axios.isAxiosError(e) && e.response?.data?.message) ||
  (e instanceof Error ? e.message : String(e));

const relative = (iso: string) => (
  <FormattedRelativeTime
    value={Math.floor((new Date(iso).getTime() - Date.now()) / 1000)}
    updateIntervalInSeconds={60}
    numeric="auto"
  />
);

interface LibrarySharingProps {
  servers: { kind: MediaServerKind; name: string }[];
}

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

/**
 * Settings → Media Servers: each connected server's libraries, how many
 * people have each, and one library taken from (or given to) everyone at
 * once, with a preview first and Undo after.
 */
const LibrarySharing = ({ servers }: LibrarySharingProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [chosen, setChosen] = useState<MediaServerKind>();
  const kind = servers.find((s) => s.kind === chosen)?.kind ?? servers[0]?.kind;
  const serverName = servers.find((s) => s.kind === kind)?.name ?? '';
  const endpoint = kind ? `/api/v1/settings/library-access/${kind}` : null;
  const {
    data,
    error,
    isValidating,
    mutate: revalidate,
  } = useSWR<LibraryAccessView>(endpoint, { revalidateOnFocus: false });
  const { data: history, mutate: revalidateHistory } = useSWR<
    AccessChangeView[]
  >(kind ? `/api/v1/settings/library-access/history?kind=${kind}` : null);

  const [asking, setAsking] = useState<{
    library: AccessLibrary;
    action: AccessBulkAction;
  }>();
  const [plan, setPlan] = useState<AccessPlan>();
  const [working, setWorking] = useState(false);
  const [undoing, setUndoing] = useState<AccessChangeView>();

  if (!kind) return null;

  const people = data?.people.filter((p) => !p.admin) ?? [];

  const ask = async (library: AccessLibrary, action: AccessBulkAction) => {
    setAsking({ library, action });
    setPlan(undefined);
    try {
      const response = await axios.post<AccessPlan>(`${endpoint}/plan`, {
        libraryId: library.id,
        action,
      });
      setPlan(response.data);
    } catch (e) {
      setAsking(undefined);
      addToast(intl.formatMessage(messages.failed, { detail: errorOf(e) }), {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };

  const failures = (result: AccessResult) =>
    result.failed.length > 0 &&
    addToast(
      intl.formatMessage(messages.someFailed, {
        server: serverName,
        names: intl.formatList(
          result.failed.map((f) => f.name),
          { type: 'conjunction' }
        ),
      }),
      { appearance: 'warning', autoDismiss: false }
    );

  const apply = async () => {
    if (!asking) return;
    setWorking(true);
    try {
      const { data: result } = await axios.post<AccessResult>(
        `${endpoint}/apply`,
        { libraryId: asking.library.id, action: asking.action }
      );
      addToast(
        intl.formatMessage(
          asking.action === 'remove' ? messages.removed : messages.shared,
          { library: asking.library.title, count: result.changed }
        ),
        { appearance: 'success', autoDismiss: true }
      );
      failures(result);
      setAsking(undefined);
    } catch (e) {
      addToast(intl.formatMessage(messages.failed, { detail: errorOf(e) }), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setWorking(false);
      revalidate();
      revalidateHistory();
    }
  };

  const undo = async () => {
    if (!undoing) return;
    setWorking(true);
    try {
      const { data: result } = await axios.post<AccessResult>(
        `/api/v1/settings/library-access/history/${undoing.id}/undo`
      );
      addToast(
        <span>
          {intl.formatMessage(messages.undoDone, { count: result.changed })}
          {!!result.skipped && (
            <>
              {' '}
              {intl.formatMessage(messages.undoSkipped, {
                count: result.skipped,
              })}
            </>
          )}
        </span>,
        { appearance: 'success', autoDismiss: true }
      );
      failures(result);
      setUndoing(undefined);
    } catch (e) {
      addToast(intl.formatMessage(messages.failed, { detail: errorOf(e) }), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setWorking(false);
      revalidate();
      revalidateHistory();
    }
  };

  const historyLine = (entry: AccessChangeView) =>
    entry.action === 'person'
      ? intl.formatMessage(messages.historyPerson, {
          name: entry.personName ?? '',
        })
      : intl.formatMessage(
          entry.action === 'remove'
            ? messages.historyRemove
            : messages.historyAdd,
          { library: entry.libraryTitle ?? '', count: entry.changed }
        );

  return (
    <div className="mt-10">
      <div className="mb-6">
        <h3 className="heading">
          {intl.formatMessage(messages.librarySharing)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.librarySharingDescription)}
        </p>
      </div>
      <div className="section max-w-6xl">
        {servers.length > 1 && (
          <div
            className="mb-4 flex flex-wrap gap-2"
            role="group"
            aria-label={intl.formatMessage(messages.librarySharing)}
          >
            {servers.map((server) => (
              <Button
                key={server.kind}
                buttonSize="sm"
                buttonType={server.kind === kind ? 'primary' : 'default'}
                aria-pressed={server.kind === kind}
                onClick={() => setChosen(server.kind)}
              >
                {server.name}
              </Button>
            ))}
          </div>
        )}

        {error && !data && (
          <Alert
            type="error"
            title={intl.formatMessage(messages.loadFailed, {
              server: serverName,
              detail: errorOf(error),
            })}
          >
            <Button
              buttonSize="sm"
              disabled={isValidating}
              onClick={() => revalidate()}
            >
              <ArrowPathIcon />
              <span>{intl.formatMessage(globalMessages.retry)}</span>
            </Button>
          </Alert>
        )}
        {!data && !error && <LoadingSpinner />}

        {data && !data.libraries.length && (
          <p className="text-sm text-gray-400">
            {intl.formatMessage(messages.noLibraries, { server: serverName })}
          </p>
        )}
        {data && data.libraries.length > 0 && (
          <ul className="divide-y divide-gray-700 overflow-hidden rounded-lg ring-1 ring-gray-700">
            {data.libraries.map((library) => {
              const holders = people.filter((p) =>
                p.libraries.includes(library.id)
              );
              return (
                <li
                  key={library.id}
                  className="flex flex-col gap-3 bg-gray-800 px-4 py-3 sm:flex-row sm:items-center"
                >
                  <div className="min-w-0 flex-1">
                    <div className="break-words font-medium text-strong">
                      {library.title}
                    </div>
                    {people.length ? (
                      <details className="text-sm text-gray-400">
                        <summary className="cursor-pointer">
                          {intl.formatMessage(messages.sharedWith, {
                            count: library.sharedWith,
                            total: people.length,
                          })}
                        </summary>
                        {holders.length > 0 && (
                          <p className="mt-1 break-words">
                            {holders.map((person, i) => (
                              <span key={person.id}>
                                {i > 0 && ', '}
                                {person.userId ? (
                                  <Link
                                    href={`/users/${person.userId}/settings/libraries`}
                                    className="text-gray-200 hover:underline"
                                  >
                                    {person.name}
                                  </Link>
                                ) : (
                                  person.name
                                )}
                                {person.disabled &&
                                  ` (${intl.formatMessage(messages.disabled)})`}
                              </span>
                            ))}
                          </p>
                        )}
                      </details>
                    ) : (
                      <p className="text-sm text-gray-400">
                        {intl.formatMessage(messages.nobodyToShare)}
                      </p>
                    )}
                  </div>
                  {people.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        buttonSize="sm"
                        disabled={library.sharedWith === 0}
                        onClick={() => ask(library, 'remove')}
                      >
                        <MinusCircleIcon />
                        <span>
                          {intl.formatMessage(messages.removeFromEveryone)}
                        </span>
                      </Button>
                      <Button
                        buttonSize="sm"
                        disabled={library.sharedWith === people.length}
                        onClick={() => ask(library, 'add')}
                      >
                        <PlusCircleIcon />
                        <span>
                          {intl.formatMessage(messages.shareWithEveryone)}
                        </span>
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <h4 className="mt-8 text-lg font-semibold text-gray-200">
          {intl.formatMessage(messages.recentChanges)}
        </h4>
        {!history?.length ? (
          <p className="mt-2 text-sm text-gray-400">
            {intl.formatMessage(messages.noChanges)}
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-gray-700 overflow-hidden rounded-lg ring-1 ring-gray-700">
            {history.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center gap-3 bg-gray-800 px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="break-words text-sm text-strong">
                    {historyLine(entry)}
                    {entry.failed > 0 &&
                      ` · ${intl.formatMessage(messages.historyFailed, {
                        count: entry.failed,
                      })}`}
                  </div>
                  <div className="text-xs text-gray-400">
                    {relative(entry.createdAt)}
                    {entry.byName &&
                      ` · ${intl.formatMessage(messages.historyBy, {
                        name: entry.byName,
                      })}`}
                  </div>
                </div>
                {entry.undoneAt ? (
                  <Badge badgeType="dark">
                    {intl.formatMessage(messages.undone)}
                  </Badge>
                ) : (
                  entry.changed > 0 && (
                    <Button buttonSize="sm" onClick={() => setUndoing(entry)}>
                      <ArrowUturnLeftIcon />
                      <span>{intl.formatMessage(messages.undo)}</span>
                    </Button>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <Fade show={!!asking}>
        {asking && (
          <Modal
            title={intl.formatMessage(
              asking.action === 'remove'
                ? messages.removeTitle
                : messages.shareTitle,
              { library: asking.library.title }
            )}
            onCancel={() => setAsking(undefined)}
            onOk={() => apply()}
            okText={
              working
                ? intl.formatMessage(messages.working)
                : intl.formatMessage(
                    asking.action === 'remove'
                      ? messages.removeCount
                      : messages.shareCount,
                    { count: plan?.change.length ?? 0 }
                  )
            }
            okButtonType={asking.action === 'remove' ? 'danger' : 'primary'}
            okDisabled={working || !plan?.change.length}
            loading={!plan}
            showCloseButton
          >
            {plan && (
              <div className="space-y-4">
                {plan.change.length ? (
                  <div>
                    <p>
                      {intl.formatMessage(
                        plan.action === 'remove'
                          ? messages.willLose
                          : messages.willGet,
                        { count: plan.change.length }
                      )}
                    </p>
                    <p className="mt-1 max-h-40 overflow-y-auto break-words text-sm text-gray-300">
                      {intl.formatList(
                        plan.change.map((p) => p.name),
                        { type: 'conjunction' }
                      )}
                    </p>
                  </div>
                ) : (
                  <p>{intl.formatMessage(messages.nobodyChanges)}</p>
                )}
                {plan.fromAll > 0 && (
                  <Alert
                    type="info"
                    title={intl.formatMessage(messages.fromAll, {
                      count: plan.fromAll,
                    })}
                  />
                )}
                {plan.emptied.length > 0 && (
                  <Alert
                    type="warning"
                    title={intl.formatMessage(messages.emptied, {
                      server: serverName,
                      names: intl.formatList(
                        plan.emptied.map((p) => p.name),
                        { type: 'conjunction' }
                      ),
                    })}
                  />
                )}
                {plan.admins > 0 && (
                  <p className="text-sm text-gray-400">
                    {intl.formatMessage(messages.admins, {
                      count: plan.admins,
                    })}
                  </p>
                )}
                {plan.change.length > 0 && (
                  <p className="text-sm text-gray-400">
                    {intl.formatMessage(messages.oneTime)}
                  </p>
                )}
              </div>
            )}
          </Modal>
        )}
      </Fade>

      <Fade show={!!undoing}>
        {undoing && (
          <Modal
            title={intl.formatMessage(messages.undoTitle)}
            onCancel={() => setUndoing(undefined)}
            onOk={() => undo()}
            okText={
              working
                ? intl.formatMessage(messages.working)
                : intl.formatMessage(messages.undo)
            }
            okButtonType="warning"
            okDisabled={working}
          >
            <p className="font-medium">{historyLine(undoing)}</p>
            <p className="mt-2 text-sm text-gray-300">
              {intl.formatMessage(messages.undoDescription)}
            </p>
          </Modal>
        )}
      </Fade>
    </div>
  );
};

export default LibrarySharing;
