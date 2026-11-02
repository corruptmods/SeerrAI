import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import SaveBar from '@app/components/Common/SaveBar';
import { SERVER_NAMES } from '@app/components/Settings/SettingsMediaServers/names';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownOnSquareIcon } from '@heroicons/react/24/outline';
import type { MediaServerKind } from '@server/constants/server';
import type {
  AccessResult,
  AccessSet,
  UserLibraryAccess,
} from '@server/interfaces/api/libraryAccessInterfaces';
import axios from 'axios';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.UserProfile.UserSettings.UserLibrarySettings',
  {
    libraries: 'Libraries',
    librariesDescription:
      'The libraries {name} sees on each media server. Saving changes them on the server.',
    everyLibrary: 'Every library, new ones too',
    notShared: '{server} is not shared with them.',
    admin: 'An administrator on {server}: sees every library.',
    disabled: 'Their {server} account is switched off.',
    loadFailed: '{server} could not be read: {detail}',
    keepOne: 'Leave at least one library on {server}.',
    saved: 'Libraries saved.',
    saveFailed: 'Something went wrong saving {server}: {detail}',
    noAccounts: 'They have no account on a connected media server.',
  }
);

const errorOf = (e: unknown) =>
  (axios.isAxiosError(e) && e.response?.data?.message) ||
  (e instanceof Error ? e.message : String(e));

type Choices = Partial<Record<MediaServerKind, AccessSet>>;

const choicesOf = (accounts: UserLibraryAccess[]): Choices =>
  Object.fromEntries(
    accounts
      .filter((a) => a.person && !a.person.admin)
      .map((a) => [
        a.kind,
        { all: a.person!.all, libraries: [...a.person!.libraries] },
      ])
  );

const sameChoice = (a?: AccessSet, b?: AccessSet) =>
  !!a &&
  !!b &&
  a.all === b.all &&
  (a.all ||
    (a.libraries.length === b.libraries.length &&
      a.libraries.every((id) => b.libraries.includes(id))));

/** A person's libraries on each media server, for an admin to change. */
const UserLibrarySettings = () => {
  const intl = useIntl();
  const router = useRouter();
  const { addToast } = useToasts();
  const { user } = useUser({ id: Number(router.query.userId) });
  const { data, error, mutate } = useSWR<UserLibraryAccess[]>(
    user ? `/api/v1/settings/library-access/user/${user.id}` : null,
    { revalidateOnFocus: false }
  );
  const [choices, setChoices] = useState<Choices>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) setChoices(choicesOf(data));
  }, [data]);

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  const loaded = data ? choicesOf(data) : {};
  const changed = (Object.keys(choices) as MediaServerKind[]).filter(
    (kind) => !sameChoice(choices[kind], loaded[kind])
  );
  const empty = changed.filter(
    (kind) => !choices[kind]?.all && !choices[kind]?.libraries.length
  );

  const toggle = (kind: MediaServerKind, id: string) =>
    setChoices((current) => {
      const choice = current[kind];
      if (!choice) return current;
      const libraries = choice.libraries.includes(id)
        ? choice.libraries.filter((l) => l !== id)
        : [...choice.libraries, id];
      return { ...current, [kind]: { ...choice, libraries } };
    });

  const save = async () => {
    setSaving(true);
    let ok = true;
    for (const kind of changed) {
      try {
        const { data: result } = await axios.put<AccessResult>(
          `/api/v1/settings/library-access/user/${user?.id}`,
          { kind, ...choices[kind] }
        );
        if (result.failed.length) {
          throw new Error(result.failed[0].error);
        }
      } catch (e) {
        ok = false;
        addToast(
          intl.formatMessage(messages.saveFailed, {
            server: SERVER_NAMES[kind],
            detail: errorOf(e),
          }),
          { appearance: 'error', autoDismiss: true }
        );
      }
    }
    if (ok) {
      addToast(intl.formatMessage(messages.saved), {
        appearance: 'success',
        autoDismiss: true,
      });
    }
    setSaving(false);
    mutate();
  };

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.libraries),
          intl.formatMessage(globalMessages.usersettings),
          user?.displayName,
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.libraries)}</h3>
        <p className="description">
          {intl.formatMessage(messages.librariesDescription, {
            name: user?.displayName ?? '',
          })}
        </p>
      </div>
      {error && <Alert type="error" title={errorOf(error)} />}
      {data && !data.length && (
        <p className="text-sm text-gray-400">
          {intl.formatMessage(messages.noAccounts)}
        </p>
      )}
      <div className="section max-w-3xl space-y-8">
        {data?.map((account) => {
          const server = SERVER_NAMES[account.kind];
          const choice = choices[account.kind];
          return (
            <section
              key={account.kind}
              aria-labelledby={`libs-${account.kind}`}
            >
              <h4
                id={`libs-${account.kind}`}
                className="text-lg font-semibold text-gray-200"
              >
                {server}
              </h4>
              {account.error ? (
                <div className="mt-2">
                  <Alert
                    type="error"
                    title={intl.formatMessage(messages.loadFailed, {
                      server,
                      detail: account.error,
                    })}
                  />
                </div>
              ) : !account.person ? (
                <p className="mt-2 text-sm text-gray-400">
                  {intl.formatMessage(messages.notShared, { server })}
                </p>
              ) : account.person.admin ? (
                <p className="mt-2 text-sm text-gray-400">
                  {intl.formatMessage(messages.admin, { server })}
                </p>
              ) : (
                choice && (
                  <div className="mt-3 space-y-3">
                    {account.person.disabled && (
                      <p className="text-sm text-yellow-300 light:text-warning-text">
                        {intl.formatMessage(messages.disabled, { server })}
                      </p>
                    )}
                    {account.canGiveAll && (
                      <label className="flex items-center gap-3 text-sm font-medium text-strong">
                        <input
                          type="checkbox"
                          checked={choice.all}
                          onChange={() =>
                            setChoices((current) => ({
                              ...current,
                              [account.kind]: {
                                all: !choice.all,
                                libraries: choice.all
                                  ? choice.libraries
                                  : account.libraries.map((l) => l.id),
                              },
                            }))
                          }
                        />
                        {intl.formatMessage(messages.everyLibrary)}
                      </label>
                    )}
                    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {account.libraries.map((library) => (
                        <li key={library.id}>
                          <label className="flex items-center gap-3 text-sm text-gray-200">
                            <input
                              type="checkbox"
                              checked={
                                choice.all ||
                                choice.libraries.includes(library.id)
                              }
                              disabled={choice.all}
                              onChange={() => toggle(account.kind, library.id)}
                            />
                            <span className="min-w-0 break-words">
                              {library.title}
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                    {empty.includes(account.kind) && (
                      <p className="text-sm text-red-400 light:text-danger-text">
                        {intl.formatMessage(messages.keepOne, { server })}
                      </p>
                    )}
                  </div>
                )
              )}
            </section>
          );
        })}
      </div>
      {Object.keys(loaded).length > 0 && (
        <SaveBar dirty={changed.length > 0}>
          <div className="flex justify-end">
            <Button
              buttonType="primary"
              disabled={saving || !changed.length || empty.length > 0}
              onClick={() => save()}
            >
              <ArrowDownOnSquareIcon />
              <span>
                {saving
                  ? intl.formatMessage(globalMessages.saving)
                  : intl.formatMessage(globalMessages.save)}
              </span>
            </Button>
          </div>
        </SaveBar>
      )}
    </>
  );
};

export default UserLibrarySettings;
