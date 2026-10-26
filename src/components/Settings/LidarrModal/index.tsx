import Modal from '@app/components/Common/Modal';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import { arrTestFailure } from '@app/components/Settings/arrTestFailure';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { isValidURL } from '@app/utils/urlValidationHelper';
import { Transition } from '@headlessui/react';
import type { LidarrSettings } from '@server/lib/settings';
import axios from 'axios';
import { Field, Formik } from 'formik';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import Select from 'react-select';
import * as Yup from 'yup';

type OptionType = {
  value: number;
  label: string;
};

/** What testing a Lidarr gives the dialog to choose from. */
interface LidarrTestResponse {
  profiles: { id: number; name: string }[];
  metadataProfiles: { id: number; name: string }[];
  rootFolders: { id: number; path: string }[];
  tags: { id: number; label: string }[];
  urlBase?: string;
}

const messages = defineMessages('components.Settings.LidarrModal', {
  createlidarr: 'Add New Lidarr Server',
  editlidarr: 'Edit Lidarr Server',
  validationNameRequired: 'You must provide a server name',
  validationHostnameRequired: 'You must provide a valid hostname or IP address',
  validationPortRequired: 'You must provide a valid port number',
  validationApiKeyRequired: 'You must provide an API key',
  validationRootFolderRequired: 'You must select a root folder',
  validationProfileRequired: 'You must select a quality profile',
  validationMetadataProfileRequired: 'You must select a metadata profile',
  toastLidarrTestSuccess: 'Lidarr connection established successfully!',
  toastLidarrTestFailure: 'Failed to connect to Lidarr.',
  saveFailed: 'Could not save the Lidarr server.',
  add: 'Add Server',
  defaultserver: 'Default Server',
  defaultserverHelp: 'Music is requested through the default server.',
  servername: 'Server Name',
  hostname: 'Hostname or IP Address',
  port: 'Port',
  ssl: 'Use SSL',
  apiKey: 'API Key',
  baseUrl: 'URL Base',
  syncEnabled: 'Enable Scan',
  externalUrl: 'External URL',
  qualityprofile: 'Quality Profile',
  metadataprofile: 'Metadata Profile',
  metadataprofileHelp:
    'Which release kinds Lidarr lists for new artists. Requests start with these ticked.',
  rootfolder: 'Root Folder',
  selectQualityProfile: 'Select quality profile',
  selectMetadataProfile: 'Select metadata profile',
  selectRootFolder: 'Select root folder',
  loadingprofiles: 'Loading quality profiles…',
  loadingmetadataprofiles: 'Loading metadata profiles…',
  testFirstQualityProfiles: 'Test connection to load quality profiles',
  testFirstMetadataProfiles: 'Test connection to load metadata profiles',
  loadingrootfolders: 'Loading root folders…',
  testFirstRootFolders: 'Test connection to load root folders',
  loadingTags: 'Loading tags…',
  testFirstTags: 'Test connection to load tags',
  tags: 'Tags',
  enableSearch: 'Enable Automatic Search',
  tagRequests: 'Tag Requests',
  tagRequestsInfo: 'Tag each artist with the requester’s user ID and name',
  validationApplicationUrl: 'You must provide a valid URL',
  validationApplicationUrlTrailingSlash: 'URL must not end in a trailing slash',
  validationBaseUrlLeadingSlash: 'URL base must have a leading slash',
  validationBaseUrlTrailingSlash: 'URL base must not end in a trailing slash',
  notagoptions: 'No tags.',
  selecttags: 'Select tags',
  apiKeyHelp: 'Find it in Lidarr: Settings > General > Security > API Key',
  baseUrlHelp:
    'Only if Lidarr has a URL Base (Settings > General > Host), such as /lidarr.',
  externalUrlHelp:
    'For links on artist pages, if the address above isn’t reachable from outside.',
  syncEnabledHelp:
    'Mark what Lidarr already has as available, so it isn’t requested again.',
  enableSearchHelp: 'Search in Lidarr as soon as a request is approved.',
});

interface LidarrModalProps {
  lidarr: LidarrSettings | null;
  onClose: () => void;
  onSave: () => void;
}

/**
 * Adding or changing a Lidarr server, as Radarr's dialog does, with a
 * metadata profile in place of minimum availability, and no 4K or anime
 * settings (Lidarr has neither).
 */
const LidarrModal = ({ onClose, lidarr, onSave }: LidarrModalProps) => {
  const intl = useIntl();
  const initialLoad = useRef(false);
  const { addToast } = useToasts();
  const [isValidated, setIsValidated] = useState(lidarr ? true : false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResponse, setTestResponse] = useState<LidarrTestResponse>({
    profiles: [],
    metadataProfiles: [],
    rootFolders: [],
    tags: [],
  });

  const LidarrSettingsSchema = Yup.object().shape({
    name: Yup.string().required(
      intl.formatMessage(messages.validationNameRequired)
    ),
    hostname: Yup.string().required(
      intl.formatMessage(messages.validationHostnameRequired)
    ),
    port: Yup.number()
      .nullable()
      .required(intl.formatMessage(messages.validationPortRequired)),
    apiKey: Yup.string().required(
      intl.formatMessage(messages.validationApiKeyRequired)
    ),
    rootFolder: Yup.string().required(
      intl.formatMessage(messages.validationRootFolderRequired)
    ),
    activeProfileId: Yup.string().required(
      intl.formatMessage(messages.validationProfileRequired)
    ),
    activeMetadataProfileId: Yup.string().required(
      intl.formatMessage(messages.validationMetadataProfileRequired)
    ),
    externalUrl: Yup.string()
      .test(
        'valid-url',
        intl.formatMessage(messages.validationApplicationUrl),
        isValidURL
      )
      .test(
        'no-trailing-slash',
        intl.formatMessage(messages.validationApplicationUrlTrailingSlash),
        (value) => !value || !value.endsWith('/')
      ),
    baseUrl: Yup.string()
      .test(
        'leading-slash',
        intl.formatMessage(messages.validationBaseUrlLeadingSlash),
        (value) => !value || value.startsWith('/')
      )
      .test(
        'no-trailing-slash',
        intl.formatMessage(messages.validationBaseUrlTrailingSlash),
        (value) => !value || !value.endsWith('/')
      ),
  });

  const testConnection = useCallback(
    async ({
      hostname,
      port,
      apiKey,
      baseUrl,
      useSsl = false,
    }: {
      hostname: string;
      port: number;
      apiKey: string;
      baseUrl?: string;
      useSsl?: boolean;
    }) => {
      setIsTesting(true);
      try {
        const response = await axios.post<LidarrTestResponse>(
          '/api/v1/settings/lidarr/test',
          {
            hostname,
            apiKey,
            port: Number(port),
            baseUrl,
            useSsl,
          }
        );

        setIsValidated(true);
        setTestResponse(response.data);
        if (initialLoad.current) {
          addToast(intl.formatMessage(messages.toastLidarrTestSuccess), {
            appearance: 'success',
            autoDismiss: true,
          });
        }
      } catch (e) {
        setIsValidated(false);
        if (initialLoad.current) {
          addToast(
            arrTestFailure(intl, e, 'Lidarr', messages.toastLidarrTestFailure),
            {
              appearance: 'error',
              autoDismiss: true,
            }
          );
        }
      } finally {
        setIsTesting(false);
        initialLoad.current = true;
      }
    },
    [addToast, intl]
  );

  useEffect(() => {
    if (lidarr) {
      testConnection({
        apiKey: lidarr.apiKey,
        hostname: lidarr.hostname,
        port: lidarr.port,
        baseUrl: lidarr.baseUrl,
        useSsl: lidarr.useSsl,
      });
    }
  }, [lidarr, testConnection]);

  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, intl.locale, {
      numeric: true,
      sensitivity: 'base',
    });

  return (
    <Transition
      as="div"
      appear
      show
      enter="transition-opacity ease-in-out duration-300"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition-opacity ease-in-out duration-300"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
    >
      <Formik
        initialValues={{
          name: lidarr?.name,
          hostname: lidarr?.hostname,
          port: lidarr?.port ?? 8686,
          ssl: lidarr?.useSsl ?? false,
          apiKey: lidarr?.apiKey,
          baseUrl: lidarr?.baseUrl,
          activeProfileId: lidarr?.activeProfileId,
          activeMetadataProfileId: lidarr?.activeMetadataProfileId,
          rootFolder: lidarr?.activeDirectory,
          tags: lidarr?.tags ?? [],
          isDefault: lidarr?.isDefault ?? false,
          externalUrl: lidarr?.externalUrl,
          syncEnabled: lidarr?.syncEnabled ?? false,
          enableSearch: !lidarr?.preventSearch,
          tagRequests: lidarr?.tagRequests ?? false,
        }}
        validationSchema={LidarrSettingsSchema}
        onSubmit={async (values) => {
          try {
            const profileName = testResponse.profiles.find(
              (profile) => profile.id === Number(values.activeProfileId)
            )?.name;
            const metadataProfileName = testResponse.metadataProfiles.find(
              (profile) => profile.id === Number(values.activeMetadataProfileId)
            )?.name;

            const submission = {
              name: values.name,
              hostname: values.hostname,
              port: Number(values.port),
              apiKey: values.apiKey,
              useSsl: values.ssl,
              baseUrl: values.baseUrl,
              activeProfileId: Number(values.activeProfileId),
              activeProfileName: profileName,
              activeMetadataProfileId: Number(values.activeMetadataProfileId),
              activeMetadataProfileName: metadataProfileName,
              activeDirectory: values.rootFolder,
              is4k: false,
              tags: values.tags,
              isDefault: values.isDefault,
              externalUrl: values.externalUrl,
              syncEnabled: values.syncEnabled,
              preventSearch: !values.enableSearch,
              tagRequests: values.tagRequests,
            };
            if (!lidarr) {
              await axios.post('/api/v1/settings/lidarr', submission);
            } else {
              await axios.put(
                `/api/v1/settings/lidarr/${lidarr.id}`,
                submission
              );
            }

            onSave();
          } catch {
            addToast(intl.formatMessage(messages.saveFailed), {
              appearance: 'error',
              autoDismiss: true,
            });
          }
        }}
      >
        {({
          errors,
          touched,
          values,
          handleSubmit,
          setFieldValue,
          isSubmitting,
          isValid,
        }) => {
          /** A select filled from the test, with its loading and waiting words. */
          const profileOptions = (
            name: 'activeProfileId' | 'activeMetadataProfileId' | 'rootFolder',
            loading: string,
            testFirst: string,
            select: string
          ) => (
            <Field
              as="select"
              id={name}
              name={name}
              disabled={!isValidated || isTesting}
            >
              <option value="">
                {isTesting ? loading : !isValidated ? testFirst : select}
              </option>
              {name === 'rootFolder'
                ? testResponse.rootFolders.map((folder) => (
                    <option key={`folder-${folder.id}`} value={folder.path}>
                      {folder.path}
                    </option>
                  ))
                : (name === 'activeProfileId'
                    ? testResponse.profiles
                    : testResponse.metadataProfiles
                  )
                    .toSorted(byName)
                    .map((profile) => (
                      <option key={`${name}-${profile.id}`} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
            </Field>
          );
          const error = (name: keyof typeof errors) =>
            errors[name] &&
            touched[name] &&
            typeof errors[name] === 'string' && (
              <div className="error">{errors[name]}</div>
            );
          const textField = (
            name: 'name' | 'hostname' | 'baseUrl',
            props: Record<string, string> = {}
          ) => (
            <Field
              id={name}
              name={name}
              type="text"
              {...props}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                setIsValidated(false);
                setFieldValue(name, e.target.value);
              }}
            />
          );

          return (
            <Modal
              onCancel={onClose}
              okButtonType="primary"
              okText={
                isSubmitting
                  ? intl.formatMessage(globalMessages.saving)
                  : lidarr
                    ? intl.formatMessage(globalMessages.save)
                    : intl.formatMessage(messages.add)
              }
              secondaryButtonType="warning"
              secondaryText={
                isTesting
                  ? intl.formatMessage(globalMessages.testing)
                  : intl.formatMessage(globalMessages.test)
              }
              onSecondary={() => {
                if (values.apiKey && values.hostname && values.port) {
                  testConnection({
                    apiKey: values.apiKey,
                    baseUrl: values.baseUrl,
                    hostname: values.hostname,
                    port: values.port,
                    useSsl: values.ssl,
                  });
                  if (!values.baseUrl || values.baseUrl === '/') {
                    setFieldValue('baseUrl', testResponse.urlBase);
                  }
                }
              }}
              secondaryDisabled={
                !values.apiKey ||
                !values.hostname ||
                !values.port ||
                isTesting ||
                isSubmitting
              }
              okDisabled={!isValidated || isSubmitting || isTesting || !isValid}
              onOk={() => handleSubmit()}
              title={intl.formatMessage(
                lidarr ? messages.editlidarr : messages.createlidarr
              )}
            >
              <div className="mb-6">
                <div className="form-row">
                  <label htmlFor="isDefault" className="checkbox-label">
                    {intl.formatMessage(messages.defaultserver)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.defaultserverHelp)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <Field type="checkbox" id="isDefault" name="isDefault" />
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="name" className="text-label">
                    {intl.formatMessage(messages.servername)}
                    <span className="label-required">*</span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      {textField('name', {
                        autoComplete: 'off',
                        'data-form-type': 'other',
                        'data-1pignore': 'true',
                        'data-lpignore': 'true',
                        'data-bwignore': 'true',
                      })}
                    </div>
                    {error('name')}
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="hostname" className="text-label">
                    {intl.formatMessage(messages.hostname)}
                    <span className="label-required">*</span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <span className="protocol">
                        {values.ssl ? 'https://' : 'http://'}
                      </span>
                      {textField('hostname', {
                        inputMode: 'url',
                        className: 'rounded-r-only',
                      })}
                    </div>
                    {error('hostname')}
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="port" className="text-label">
                    {intl.formatMessage(messages.port)}
                    <span className="label-required">*</span>
                  </label>
                  <div className="form-input-area">
                    <Field
                      id="port"
                      name="port"
                      type="text"
                      inputMode="numeric"
                      className="short"
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                        setIsValidated(false);
                        setFieldValue('port', e.target.value);
                      }}
                    />
                    {error('port')}
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="ssl" className="checkbox-label">
                    {intl.formatMessage(messages.ssl)}
                  </label>
                  <div className="form-input-area">
                    <Field
                      type="checkbox"
                      id="ssl"
                      name="ssl"
                      onChange={() => {
                        setIsValidated(false);
                        setFieldValue('ssl', !values.ssl);
                      }}
                    />
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="apiKey" className="text-label">
                    {intl.formatMessage(messages.apiKey)}
                    <span className="label-required">*</span>
                    <span className="label-tip">
                      {intl.formatMessage(messages.apiKeyHelp)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <SensitiveInput
                        as="field"
                        id="apiKey"
                        name="apiKey"
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                          setIsValidated(false);
                          setFieldValue('apiKey', e.target.value);
                        }}
                      />
                    </div>
                    {error('apiKey')}
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="baseUrl" className="text-label">
                    {intl.formatMessage(messages.baseUrl)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.baseUrlHelp)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      {textField('baseUrl', { inputMode: 'url' })}
                    </div>
                    {error('baseUrl')}
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="activeProfileId" className="text-label">
                    {intl.formatMessage(messages.qualityprofile)}
                    <span className="label-required">*</span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      {profileOptions(
                        'activeProfileId',
                        intl.formatMessage(messages.loadingprofiles),
                        intl.formatMessage(messages.testFirstQualityProfiles),
                        intl.formatMessage(messages.selectQualityProfile)
                      )}
                    </div>
                    {error('activeProfileId')}
                  </div>
                </div>
                <div className="form-row">
                  <label
                    htmlFor="activeMetadataProfileId"
                    className="text-label"
                  >
                    {intl.formatMessage(messages.metadataprofile)}
                    <span className="label-required">*</span>
                    <span className="label-tip">
                      {intl.formatMessage(messages.metadataprofileHelp)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      {profileOptions(
                        'activeMetadataProfileId',
                        intl.formatMessage(messages.loadingmetadataprofiles),
                        intl.formatMessage(messages.testFirstMetadataProfiles),
                        intl.formatMessage(messages.selectMetadataProfile)
                      )}
                    </div>
                    {error('activeMetadataProfileId')}
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="rootFolder" className="text-label">
                    {intl.formatMessage(messages.rootfolder)}
                    <span className="label-required">*</span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      {profileOptions(
                        'rootFolder',
                        intl.formatMessage(messages.loadingrootfolders),
                        intl.formatMessage(messages.testFirstRootFolders),
                        intl.formatMessage(messages.selectRootFolder)
                      )}
                    </div>
                    {error('rootFolder')}
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="tags" className="text-label">
                    {intl.formatMessage(messages.tags)}
                  </label>
                  <div className="form-input-area">
                    <Select<OptionType, true>
                      inputId="tags"
                      options={
                        isValidated
                          ? testResponse.tags.map((tag) => ({
                              label: tag.label,
                              value: tag.id,
                            }))
                          : []
                      }
                      isMulti
                      isDisabled={!isValidated || isTesting}
                      placeholder={
                        !isValidated
                          ? intl.formatMessage(messages.testFirstTags)
                          : isTesting
                            ? intl.formatMessage(messages.loadingTags)
                            : intl.formatMessage(messages.selecttags)
                      }
                      className="react-select-container"
                      classNamePrefix="react-select"
                      value={values.tags.flatMap((tagId) => {
                        const tag = testResponse.tags.find(
                          (t) => t.id === tagId
                        );
                        return tag ? [{ value: tag.id, label: tag.label }] : [];
                      })}
                      onChange={(value) => {
                        setFieldValue(
                          'tags',
                          value.map((option) => option.value)
                        );
                      }}
                      noOptionsMessage={() =>
                        intl.formatMessage(messages.notagoptions)
                      }
                    />
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="externalUrl" className="text-label">
                    {intl.formatMessage(messages.externalUrl)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.externalUrlHelp)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field
                        id="externalUrl"
                        name="externalUrl"
                        type="text"
                        inputMode="url"
                      />
                    </div>
                    {error('externalUrl')}
                  </div>
                </div>
                {(
                  [
                    [
                      'syncEnabled',
                      messages.syncEnabled,
                      messages.syncEnabledHelp,
                    ],
                    [
                      'enableSearch',
                      messages.enableSearch,
                      messages.enableSearchHelp,
                    ],
                    [
                      'tagRequests',
                      messages.tagRequests,
                      messages.tagRequestsInfo,
                    ],
                  ] as const
                ).map(([name, label, tip]) => (
                  <div className="form-row" key={name}>
                    <label htmlFor={name} className="checkbox-label">
                      {intl.formatMessage(label)}
                      <span className="label-tip">
                        {intl.formatMessage(tip)}
                      </span>
                    </label>
                    <div className="form-input-area">
                      <Field type="checkbox" id={name} name={name} />
                    </div>
                  </div>
                ))}
              </div>
            </Modal>
          );
        }}
      </Formik>
    </Transition>
  );
};

export default LidarrModal;
