/* eslint-disable react-hooks/exhaustive-deps */
import CachedImage from '@app/components/Common/CachedImage';
import { SmallLoadingSpinner } from '@app/components/Common/LoadingSpinner';
import SlideCheckbox from '@app/components/Common/SlideCheckbox';
import useToasts from '@app/hooks/useToasts';
import type { User } from '@app/hooks/useUser';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { formatBytes } from '@app/utils/numberHelpers';
import {
  Label,
  Listbox,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
  Transition,
} from '@headlessui/react';
import { CheckIcon, ChevronDownIcon } from '@heroicons/react/24/solid';
import { shownEmail } from '@server/constants/oidc';
import type { SeriesType } from '@server/constants/seriesType';
import type {
  ServiceCommonServer,
  ServiceCommonServerWithDetails,
} from '@server/interfaces/api/serviceInterfaces';
import type { UserResultsResponse } from '@server/interfaces/api/userInterfaces';
import type { OverrideRulesResult } from '@server/lib/overrideRules';
import { hasPermission } from '@server/lib/permissions';
import axios from 'axios';
import isEqual from 'lodash/isEqual';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import Select from 'react-select';
import useSWR from 'swr';

type OptionType = {
  value: number;
  label: string;
};

const messages = defineMessages('components.RequestModal.AdvancedRequester', {
  advancedoptions: 'Advanced',
  destinationserver: 'Destination Server',
  qualityprofile: 'Quality Profile',
  rootfolder: 'Root Folder',
  default: '{name} (Default)',
  folder: '{path} ({space})',
  requestas: 'Request As',
  languageprofile: 'Language Profile',
  tags: 'Tags',
  selecttags: 'Select tags',
  notagoptions: 'No tags.',
  ignoreQuotaTitle: 'Bypass User Quota',
  ignoreQuotaDescription: 'Won’t count against the user’s quota.',
});

export type RequestOverrides = {
  server?: number;
  profile?: number;
  folder?: string;
  tags?: number[];
  language?: number;
  user?: User;
  ignoreQuota?: boolean;
};

interface AdvancedRequesterProps {
  type: 'movie' | 'tv';
  tmdbId?: number;
  is4k: boolean;
  /** Whether anime detection says the title is anime. */
  isAnime?: boolean;
  /** The title's own anime setting, which stands over rules and detection. */
  animeSetting?: boolean | null;
  /** The type already on the request being edited. */
  requestSeriesType?: SeriesType | null;
  /** Anime or not as ticked in the dialog; null while left be. */
  animeChoice?: boolean | null;
  /** Told a matching rule's series type, which the dialog's tick starts from. */
  onRuleSeriesType?: (seriesType: SeriesType | null) => void;
  defaultOverrides?: RequestOverrides;
  requestUser?: User;
  requestId?: number;
  quota?: { movie: { limit?: number }; tv: { limit?: number } };
  onChange: (overrides: RequestOverrides) => void;
}

const AdvancedRequester = ({
  type,
  tmdbId,
  is4k = false,
  isAnime = false,
  animeSetting = null,
  requestSeriesType = null,
  animeChoice = null,
  onRuleSeriesType,
  defaultOverrides,
  requestUser,
  requestId,
  quota,
  onChange,
}: AdvancedRequesterProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { user: currentUser, hasPermission: currentHasPermission } = useUser();
  const { data, error } = useSWR<ServiceCommonServer[]>(
    `/api/v1/service/${type === 'movie' ? 'radarr' : 'sonarr'}`,
    {
      refreshInterval: 0,
      refreshWhenHidden: false,
      revalidateOnFocus: false,
      revalidateOnMount: true,
    }
  );
  const [selectedServer, setSelectedServer] = useState<number | null>(
    defaultOverrides?.server !== undefined && defaultOverrides?.server >= 0
      ? defaultOverrides?.server
      : null
  );
  const [selectedProfile, setSelectedProfile] = useState<number>(
    defaultOverrides?.profile ?? -1
  );
  const [selectedFolder, setSelectedFolder] = useState<string>(
    defaultOverrides?.folder ?? ''
  );

  const [selectedLanguage, setSelectedLanguage] = useState<number>(
    defaultOverrides?.language ?? -1
  );

  const [selectedTags, setSelectedTags] = useState<number[]>(
    defaultOverrides?.tags ?? []
  );

  const [ignoreQuota, setIgnoreQuota] = useState<boolean>(
    defaultOverrides?.ignoreQuota ?? false
  );
  // Whether it goes as anime, as the dialog's Anime tick shows it (see
  // AnimeChoice): the tick, else the request's own type when editing, the
  // title's setting, a matching rule, then detection.
  const [ruleSeriesType, setRuleSeriesType] = useState<SeriesType | null>(null);
  const anime =
    animeChoice ??
    (requestSeriesType
      ? requestSeriesType === 'anime'
      : (animeSetting ??
        (ruleSeriesType ? ruleSeriesType === 'anime' : isAnime)));
  // A series always takes the anime tags; a movie only when there are any,
  // as it is sent (lib/radarrRouting).
  const kindTags = (server: ServiceCommonServer, value: boolean) =>
    value && (type === 'tv' || server.activeAnimeTags?.length)
      ? server.activeAnimeTags
      : server.activeTags;

  const isIgnoreQuotaVisible =
    currentHasPermission([Permission.MANAGE_REQUESTS]) &&
    ((type === 'movie' ? quota?.movie.limit : quota?.tv.limit) ?? 0) > 0;

  const { data: serverData, isValidating } =
    useSWR<ServiceCommonServerWithDetails>(
      selectedServer !== null
        ? `/api/v1/service/${
            type === 'movie' ? 'radarr' : 'sonarr'
          }/${selectedServer}`
        : null,
      {
        refreshInterval: 0,
        refreshWhenHidden: false,
        revalidateOnFocus: false,
      }
    );

  const [selectedUser, setSelectedUser] = useState<User | null>(
    requestUser ?? null
  );
  const selectedUserId = selectedUser?.id;
  const previousSelectedUserIdRef = useRef<number | undefined>(selectedUserId);

  const { data: userData } = useSWR<UserResultsResponse>(
    currentHasPermission([Permission.MANAGE_REQUESTS, Permission.MANAGE_USERS])
      ? '/api/v1/user?take=1000&sort=displayname'
      : null
  );
  const filteredUserData = useMemo(
    () =>
      userData?.results.filter((user) =>
        hasPermission(
          is4k
            ? [
                Permission.REQUEST_4K,
                type === 'movie'
                  ? Permission.REQUEST_4K_MOVIE
                  : Permission.REQUEST_4K_TV,
              ]
            : [
                Permission.REQUEST,
                type === 'movie'
                  ? Permission.REQUEST_MOVIE
                  : Permission.REQUEST_TV,
              ],
          user.permissions,
          { type: 'or' }
        )
      ),
    [userData?.results]
  );

  useEffect(() => {
    if (filteredUserData && !requestUser) {
      const nextSelectedUser =
        filteredUserData.find((u) => u.id === currentUser?.id) ?? null;

      if (nextSelectedUser?.id !== selectedUserId) {
        setIgnoreQuota(false);
      }

      setSelectedUser(nextSelectedUser);
    }
  }, [filteredUserData]);

  useEffect(() => {
    let defaultServer = data?.find(
      (server) => server.isDefault && is4k === server.is4k
    );

    if (!defaultServer && (data ?? []).length > 0) {
      defaultServer = data?.[0];
    }

    if (
      defaultServer &&
      defaultServer.id !== selectedServer &&
      (!defaultOverrides || defaultOverrides.server === null)
    ) {
      setSelectedServer(defaultServer.id);
    }
  }, [data]);

  useEffect(() => {
    if (serverData) {
      const defaultProfile = serverData.profiles.find(
        (profile) =>
          profile.id ===
          (anime && serverData.server.activeAnimeProfileId
            ? serverData.server.activeAnimeProfileId
            : serverData.server.activeProfileId)
      );
      const defaultFolder = serverData.rootFolders.find(
        (folder) =>
          folder.path ===
          (anime && serverData.server.activeAnimeDirectory
            ? serverData.server.activeAnimeDirectory
            : serverData.server.activeDirectory)
      );
      const defaultLanguage = serverData.languageProfiles?.find(
        (language) =>
          language.id ===
          (anime && serverData.server.activeAnimeLanguageProfileId
            ? serverData.server.activeAnimeLanguageProfileId
            : serverData.server.activeLanguageProfileId)
      );
      const defaultTags = kindTags(serverData.server, anime);

      const applyOverrides =
        defaultOverrides &&
        ((defaultOverrides.server === null && serverData.server.isDefault) ||
          defaultOverrides.server === serverData.server.id);

      if (
        defaultProfile &&
        defaultProfile.id !== selectedProfile &&
        (!applyOverrides || defaultOverrides.profile === null)
      ) {
        setSelectedProfile(defaultProfile.id);
      }

      if (
        defaultFolder &&
        defaultFolder.path !== selectedFolder &&
        (!applyOverrides || !defaultOverrides.folder)
      ) {
        setSelectedFolder(defaultFolder.path ?? '');
      }

      if (
        defaultLanguage &&
        defaultLanguage.id !== selectedLanguage &&
        (!applyOverrides || defaultOverrides.language === null)
      ) {
        setSelectedLanguage(defaultLanguage.id);
      }

      if (
        defaultTags &&
        !isEqual(defaultTags, selectedTags) &&
        (!applyOverrides || defaultOverrides.tags === null)
      ) {
        setSelectedTags(defaultTags);
      }
    }
  }, [serverData]);

  useEffect(() => {
    if (defaultOverrides && defaultOverrides.server != null) {
      setSelectedServer(defaultOverrides.server);
    }

    if (defaultOverrides && defaultOverrides.profile != null) {
      setSelectedProfile(defaultOverrides.profile);
    }

    if (defaultOverrides && defaultOverrides.folder) {
      setSelectedFolder(defaultOverrides.folder);
    }

    if (defaultOverrides && defaultOverrides.language != null) {
      setSelectedLanguage(defaultOverrides.language);
    }

    if (defaultOverrides && defaultOverrides.tags != null) {
      setSelectedTags(defaultOverrides.tags);
    }

    if (defaultOverrides && defaultOverrides.ignoreQuota != null) {
      setIgnoreQuota(defaultOverrides.ignoreQuota);
    }
  }, [
    defaultOverrides?.server,
    defaultOverrides?.folder,
    defaultOverrides?.profile,
    defaultOverrides?.language,
    defaultOverrides?.tags,
    defaultOverrides?.ignoreQuota,
  ]);

  /**
   * Starts the request from that kind of title's folder, profiles and tags:
   * the server's anime ones, where it has them, or its standard ones.
   */
  const applyKindDefaults = (value: boolean) => {
    if (!serverData) {
      return;
    }
    const server = serverData.server;
    const profile =
      value && server.activeAnimeProfileId
        ? server.activeAnimeProfileId
        : server.activeProfileId;
    const folder =
      value && server.activeAnimeDirectory
        ? server.activeAnimeDirectory
        : server.activeDirectory;
    const language =
      value && server.activeAnimeLanguageProfileId
        ? server.activeAnimeLanguageProfileId
        : server.activeLanguageProfileId;
    if (serverData.profiles.some((p) => p.id === profile)) {
      setSelectedProfile(profile);
    }
    if (serverData.rootFolders.some((f) => f.path === folder)) {
      setSelectedFolder(folder);
    }
    if (
      language !== undefined &&
      serverData.languageProfiles?.some((l) => l.id === language)
    ) {
      setSelectedLanguage(language);
    }
    setSelectedTags(kindTags(server, value) ?? []);
  };

  // Ticking or unticking Anime starts from that kind's folder, profiles and
  // tags; they can still be changed after.
  const previousChoice = useRef(animeChoice);
  useEffect(() => {
    if (previousChoice.current === animeChoice) {
      return;
    }
    previousChoice.current = animeChoice;
    applyKindDefaults(anime);
  }, [animeChoice]);

  useEffect(() => {
    const selectedUserChanged =
      previousSelectedUserIdRef.current !== selectedUserId;
    previousSelectedUserIdRef.current = selectedUserId;

    if (!isIgnoreQuotaVisible || selectedUserChanged) {
      setIgnoreQuota(false);
    }
  }, [isIgnoreQuotaVisible, selectedUserId]);

  useEffect(() => {
    if (selectedServer !== null || selectedUser) {
      onChange({
        folder: selectedFolder !== '' ? selectedFolder : undefined,
        profile: selectedProfile !== -1 ? selectedProfile : undefined,
        server: selectedServer ?? undefined,
        user: selectedUser ?? undefined,
        language: selectedLanguage !== -1 ? selectedLanguage : undefined,
        tags: selectedTags,
        ignoreQuota: isIgnoreQuotaVisible && ignoreQuota ? true : undefined,
      });
    }
  }, [
    selectedFolder,
    selectedServer,
    selectedProfile,
    selectedUser,
    selectedLanguage,
    selectedTags,
    ignoreQuota,
    isIgnoreQuotaVisible,
  ]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (tmdbId && serverData?.server.id === selectedServer) {
        try {
          const { data: override } = await axios.post<OverrideRulesResult>(
            '/api/v1/overrideRule/advancedRequest',
            {
              mediaType: type,
              is4k,
              requestUser:
                selectedUser?.id ?? requestUser?.id ?? currentUser?.id,
              tmdbId,
              tags: selectedTags.length > 0 ? selectedTags : undefined,
              serviceId: selectedServer ?? undefined,
              requestId: requestId ?? undefined,
              // Rules match as the request will be sent: as anime or not
              // as ticked.
              seriesType:
                animeChoice === null
                  ? (requestSeriesType ?? undefined)
                  : animeChoice
                    ? 'anime'
                    : 'standard',
            }
          );
          if (cancelled) {
            return;
          }
          // A rule that makes this anime (or not) against detection starts
          // from that kind's settings; its own folder, profile and tags
          // then apply on top.
          setRuleSeriesType(override.seriesType ?? null);
          onRuleSeriesType?.(override.seriesType ?? null);
          if (
            override.seriesType &&
            animeChoice === null &&
            animeSetting === null &&
            !defaultOverrides &&
            (override.seriesType === 'anime') !== isAnime
          ) {
            applyKindDefaults(override.seriesType === 'anime');
          }
          if (!defaultOverrides?.folder && override.rootFolder) {
            setSelectedFolder(override.rootFolder);
          }
          if (!defaultOverrides?.profile && override.profileId) {
            setSelectedProfile(override.profileId);
          }
          if (
            !defaultOverrides?.tags &&
            override.tags &&
            !isEqual(override.tags, selectedTags)
          ) {
            setSelectedTags(override.tags);
          }
        } catch {
          if (cancelled) {
            return;
          }
          addToast(intl.formatMessage(globalMessages.error), {
            appearance: 'error',
            autoDismiss: true,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    tmdbId,
    type,
    is4k,
    serverData?.server.id,
    selectedServer,
    selectedUserId,
    requestUser?.id,
    currentUser?.id,
    defaultOverrides?.folder,
    defaultOverrides?.profile,
    defaultOverrides?.tags,
    // Ticked or unticked, a rule for anime (or not) may now apply, on top
    // of the kind's own folder, profile and tags.
    animeChoice,
    requestSeriesType,
  ]);

  if (!data && !error) {
    return (
      <div className="mb-2 w-full">
        <SmallLoadingSpinner />
      </div>
    );
  }

  if (
    (!data ||
      selectedServer === null ||
      (data.filter((server) => server.is4k === is4k).length < 2 &&
        (!serverData ||
          (serverData.profiles.length < 2 &&
            serverData.rootFolders.length < 2 &&
            (serverData.languageProfiles ?? []).length < 2 &&
            !serverData.tags?.length)))) &&
    (!selectedUser || (filteredUserData ?? []).length < 2)
  ) {
    return null;
  }

  return (
    <>
      <div className="mb-2 mt-4 flex items-center text-lg font-semibold">
        {intl.formatMessage(messages.advancedoptions)}
      </div>
      <div className="rounded-md">
        {!!data && selectedServer !== null && (
          <div className="flex flex-col md:flex-row">
            {data.filter((server) => server.is4k === is4k).length > 1 && (
              <div className="mb-3 w-full flex-shrink-0 flex-grow last:pr-0 md:w-1/4 md:pr-4">
                <label htmlFor="server">
                  {intl.formatMessage(messages.destinationserver)}
                </label>
                <select
                  id="server"
                  name="server"
                  value={selectedServer}
                  onChange={(e) => setSelectedServer(Number(e.target.value))}
                  onBlur={(e) => setSelectedServer(Number(e.target.value))}
                  className="border-gray-700 bg-gray-800"
                >
                  {data
                    .filter((server) => server.is4k === is4k)
                    .map((server) => (
                      <option
                        key={`server-list-${server.id}`}
                        value={server.id}
                      >
                        {server.isDefault
                          ? intl.formatMessage(messages.default, {
                              name: server.name,
                            })
                          : server.name}
                      </option>
                    ))}
                </select>
              </div>
            )}
            {(isValidating ||
              !serverData ||
              serverData.profiles.length > 1) && (
              <div className="mb-3 w-full flex-shrink-0 flex-grow last:pr-0 md:w-1/4 md:pr-4">
                <label htmlFor="profile">
                  {intl.formatMessage(messages.qualityprofile)}
                </label>
                <select
                  id="profile"
                  name="profile"
                  value={selectedProfile}
                  onChange={(e) => setSelectedProfile(Number(e.target.value))}
                  onBlur={(e) => setSelectedProfile(Number(e.target.value))}
                  className="border-gray-700 bg-gray-800"
                  disabled={isValidating || !serverData}
                >
                  {(isValidating || !serverData) && (
                    <option value="">
                      {intl.formatMessage(globalMessages.loading)}
                    </option>
                  )}
                  {!isValidating &&
                    serverData &&
                    serverData.profiles
                      .toSorted((a, b) =>
                        a.name.localeCompare(b.name, intl.locale, {
                          numeric: true,
                          sensitivity: 'base',
                        })
                      )
                      .map((profile) => (
                        <option
                          key={`profile-list${profile.id}`}
                          value={profile.id}
                        >
                          {anime &&
                          serverData.server.activeAnimeProfileId === profile.id
                            ? intl.formatMessage(messages.default, {
                                name: profile.name,
                              })
                            : !anime &&
                                serverData.server.activeProfileId === profile.id
                              ? intl.formatMessage(messages.default, {
                                  name: profile.name,
                                })
                              : profile.name}
                        </option>
                      ))}
                </select>
              </div>
            )}
            {(isValidating ||
              !serverData ||
              serverData.rootFolders.length > 1) && (
              <div className="mb-3 w-full flex-shrink-0 flex-grow last:pr-0 md:w-1/4 md:pr-4">
                <label htmlFor="folder">
                  {intl.formatMessage(messages.rootfolder)}
                </label>
                <select
                  id="folder"
                  name="folder"
                  value={selectedFolder}
                  onChange={(e) => setSelectedFolder(e.target.value)}
                  onBlur={(e) => setSelectedFolder(e.target.value)}
                  className="border-gray-700 bg-gray-800"
                  disabled={isValidating || !serverData}
                >
                  {(isValidating || !serverData) && (
                    <option value="">
                      {intl.formatMessage(globalMessages.loading)}
                    </option>
                  )}
                  {!isValidating &&
                    serverData &&
                    serverData.rootFolders.map((folder) => (
                      <option
                        key={`folder-list${folder.id}`}
                        value={folder.path}
                      >
                        {anime &&
                        serverData.server.activeAnimeDirectory === folder.path
                          ? intl.formatMessage(messages.default, {
                              name: intl.formatMessage(messages.folder, {
                                path: folder.path,
                                space: formatBytes(folder.freeSpace ?? 0),
                              }),
                            })
                          : !anime &&
                              serverData.server.activeDirectory === folder.path
                            ? intl.formatMessage(messages.default, {
                                name: intl.formatMessage(messages.folder, {
                                  path: folder.path,
                                  space: formatBytes(folder.freeSpace ?? 0),
                                }),
                              })
                            : intl.formatMessage(messages.folder, {
                                path: folder.path,
                                space: formatBytes(folder.freeSpace ?? 0),
                              })}
                      </option>
                    ))}
                </select>
              </div>
            )}
            {type === 'tv' &&
              (isValidating ||
                !serverData ||
                (serverData.languageProfiles ?? []).length > 1) && (
                <div className="mb-3 w-full flex-shrink-0 flex-grow last:pr-0 md:w-1/4 md:pr-4">
                  <label htmlFor="language">
                    {intl.formatMessage(messages.languageprofile)}
                  </label>
                  <select
                    id="language"
                    name="language"
                    value={selectedLanguage}
                    onChange={(e) =>
                      setSelectedLanguage(parseInt(e.target.value))
                    }
                    onBlur={(e) =>
                      setSelectedLanguage(parseInt(e.target.value))
                    }
                    className="border-gray-700 bg-gray-800"
                    disabled={isValidating || !serverData}
                  >
                    {(isValidating || !serverData) && (
                      <option value="">
                        {intl.formatMessage(globalMessages.loading)}
                      </option>
                    )}
                    {!isValidating &&
                      serverData &&
                      serverData.languageProfiles?.map((language) => (
                        <option
                          key={`folder-list${language.id}`}
                          value={language.id}
                        >
                          {anime &&
                          serverData.server.activeAnimeLanguageProfileId ===
                            language.id
                            ? intl.formatMessage(messages.default, {
                                name: language.name,
                              })
                            : !anime &&
                                serverData.server.activeLanguageProfileId ===
                                  language.id
                              ? intl.formatMessage(messages.default, {
                                  name: language.name,
                                })
                              : language.name}
                        </option>
                      ))}
                  </select>
                </div>
              )}
          </div>
        )}
        {selectedServer !== null &&
          (isValidating || !serverData || !!serverData?.tags?.length) && (
            <div className="mb-2">
              <label htmlFor="tags">{intl.formatMessage(messages.tags)}</label>
              <Select<OptionType, true>
                name="tags"
                options={(serverData?.tags ?? []).map((tag) => ({
                  label: tag.label,
                  value: tag.id,
                }))}
                isMulti
                isDisabled={isValidating || !serverData}
                placeholder={
                  isValidating || !serverData
                    ? intl.formatMessage(globalMessages.loading)
                    : intl.formatMessage(messages.selecttags)
                }
                className="react-select-container react-select-container-dark"
                classNamePrefix="react-select"
                value={
                  selectedTags
                    .map((tagId) => {
                      const foundTag = serverData?.tags.find(
                        (tag) => tag.id === tagId
                      );

                      if (!foundTag) {
                        return undefined;
                      }

                      return {
                        value: foundTag.id,
                        label: foundTag.label,
                      };
                    })
                    .filter((option) => option !== undefined) as OptionType[]
                }
                onChange={(value) => {
                  setSelectedTags(value.map((option) => option.value));
                }}
                noOptionsMessage={() =>
                  intl.formatMessage(messages.notagoptions)
                }
              />
            </div>
          )}
        {isIgnoreQuotaVisible && (
          <div className="mb-2">
            <label htmlFor="ignoreQuota">
              {intl.formatMessage(messages.ignoreQuotaTitle)}
            </label>
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-400">
                {intl.formatMessage(messages.ignoreQuotaDescription)}
              </p>
              <SlideCheckbox
                label={intl.formatMessage(messages.ignoreQuotaTitle)}
                checked={ignoreQuota}
                onClick={() => setIgnoreQuota(!ignoreQuota)}
              />
            </div>
          </div>
        )}
        {currentHasPermission([
          Permission.MANAGE_REQUESTS,
          Permission.MANAGE_USERS,
        ]) &&
          selectedUser &&
          (filteredUserData ?? []).length > 1 && (
            <Listbox
              as="div"
              value={selectedUser}
              onChange={(value) => {
                setIgnoreQuota(false);
                setSelectedUser(value);
              }}
              className="space-y-1"
            >
              {({ open }) => (
                <>
                  <Label>{intl.formatMessage(messages.requestas)}</Label>
                  <div className="relative">
                    <span className="inline-block w-full rounded-md shadow-sm">
                      <ListboxButton className="focus:shadow-outline-blue relative w-full cursor-default rounded-md border border-gray-700 bg-gray-800 py-2 pl-3 pr-10 text-left text-strong transition duration-150 ease-in-out focus:border-blue-300 focus:outline-none sm:text-sm sm:leading-5">
                        <span className="flex items-center">
                          <CachedImage
                            type="avatar"
                            src={selectedUser.avatar}
                            alt=""
                            className="h-6 w-6 flex-shrink-0 rounded-full object-cover"
                            width={24}
                            height={24}
                          />
                          <span className="ml-3 block">
                            {selectedUser.displayName}
                          </span>
                          {shownEmail(
                            selectedUser.displayName,
                            selectedUser.email
                          ) && (
                            <span className="ml-1 truncate text-gray-400">
                              ({selectedUser.email})
                            </span>
                          )}
                        </span>
                        <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-gray-500">
                          <ChevronDownIcon className="h-5 w-5" />
                        </span>
                      </ListboxButton>
                    </span>

                    <Transition
                      as="div"
                      show={open}
                      enter="transition-opacity ease-in duration-300"
                      enterFrom="opacity-0"
                      enterTo="opacity-100"
                      leave="transition-opacity ease-in duration-100"
                      leaveFrom="opacity-100"
                      leaveTo="opacity-0"
                      className="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 shadow-lg"
                    >
                      <ListboxOptions
                        static
                        className="shadow-xs max-h-60 overflow-auto rounded-md py-1 text-base leading-6 focus:outline-none sm:text-sm sm:leading-5"
                      >
                        {filteredUserData?.map((user) => (
                          <ListboxOption key={user.id} value={user}>
                            {({ selected, active }) => (
                              <div
                                className={`${
                                  active
                                    ? 'bg-accent text-on-accent'
                                    : 'text-gray-300'
                                } relative cursor-default select-none py-2 pl-8 pr-4`}
                              >
                                <span
                                  className={`${
                                    selected ? 'font-semibold' : 'font-normal'
                                  } flex items-center`}
                                >
                                  <CachedImage
                                    type="avatar"
                                    src={user.avatar}
                                    alt=""
                                    className="h-6 w-6 flex-shrink-0 rounded-full object-cover"
                                    width={24}
                                    height={24}
                                  />
                                  <span className="ml-3 block flex-shrink-0">
                                    {user.displayName}
                                  </span>
                                  {shownEmail(user.displayName, user.email) && (
                                    <span className="ml-1 min-w-0 text-gray-400 [overflow-wrap:anywhere]">
                                      ({user.email})
                                    </span>
                                  )}
                                </span>
                                {selected && (
                                  <span
                                    className={`${
                                      active
                                        ? 'text-on-accent'
                                        : 'text-indigo-600'
                                    } absolute inset-y-0 left-0 flex items-center pl-1.5`}
                                  >
                                    <CheckIcon className="h-5 w-5" />
                                  </span>
                                )}
                              </div>
                            )}
                          </ListboxOption>
                        ))}
                      </ListboxOptions>
                    </Transition>
                  </div>
                </>
              )}
            </Listbox>
          )}
      </div>
    </>
  );
};

export default AdvancedRequester;
