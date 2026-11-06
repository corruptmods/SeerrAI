import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import SaveBar from '@app/components/Common/SaveBar';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import NotificationTypeSelector from '@app/components/NotificationTypeSelector';
import { availableLanguages } from '@app/context/LanguageContext';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { isValidURL } from '@app/utils/urlValidationHelper';
import { ArrowDownOnSquareIcon, BeakerIcon } from '@heroicons/react/24/outline';
import type { UserResultsResponse } from '@server/interfaces/api/userInterfaces';
import { Permission, hasPermission } from '@server/lib/permissions';
import type { NotificationAgentNtfy } from '@server/lib/settings';
import axios from 'axios';
import { Field, Form, Formik } from 'formik';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';
import * as Yup from 'yup';

const messages = defineMessages(
  'components.Settings.Notifications.NotificationsNtfy',
  {
    agentenabled: 'Enable Agent',
    embedPoster: 'Embed Poster',
    url: 'Server root URL',
    topic: 'Topic',
    tags: 'Tags',
    tagsPlaceholder: 'eyes,warning',
    usernamePasswordAuth: 'Username + Password authentication',
    username: 'Username',
    password: 'Password',
    tokenAuth: 'Token authentication',
    token: 'Token',
    priority: 'Priority',
    priorityMin: 'Minimum',
    priorityLow: 'Low',
    priorityDefault: 'Default',
    priorityHigh: 'High',
    priorityUrgent: 'Urgent',
    ntfysettingssaved: 'Ntfy notification settings saved successfully!',
    ntfysettingsfailed: 'Ntfy notification settings failed to save.',
    toastNtfyTestSending: 'Sending ntfy test notification…',
    toastNtfyTestSuccess: 'Ntfy test notification sent!',
    toastNtfyTestFailed: 'Ntfy test notification failed to send.',
    validationNtfyUrl: 'You must provide a valid URL',
    validationNtfyTopic: 'You must provide a topic',
    validationPriorityRequired: 'You must provide a priority between 1 and 5',
    validationTypes: 'You must select at least one notification type',
    approvalButtons: 'Approve and Decline Buttons',
    approvalButtonsTip:
      'Adds Approve and Decline to requests waiting for approval. The phone sends a press straight to the Application URL, so it must be able to reach it. Anyone who can read this topic can use them',
    approvalButtonsNeedUrl:
      'Set the Application URL in Settings → General to use these',
    approveAs: 'Approve As',
    approveAsTip:
      'Whose approval the buttons give; it must be an account that can manage requests',
  }
);

const NotificationsNtfy = () => {
  const intl = useIntl();
  const { addToast, removeToast } = useToasts();
  const [isTesting, setIsTesting] = useState(false);
  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<NotificationAgentNtfy>('/api/v1/settings/notifications/ntfy');
  const { applicationUrl } = useSettings().currentSettings;
  const { data: users } = useSWR<UserResultsResponse>(
    '/api/v1/user?take=1000&sort=displayname'
  );
  const approvers = (users?.results ?? []).filter((user) =>
    hasPermission(Permission.MANAGE_REQUESTS, user.permissions)
  );

  const NotificationsNtfySchema = Yup.object().shape({
    url: Yup.string()
      .when('enabled', {
        is: true,
        then: (schema) =>
          schema
            .nullable()
            .required(intl.formatMessage(messages.validationNtfyUrl)),
        otherwise: (schema) => schema.nullable(),
      })
      .test(
        'valid-url',
        intl.formatMessage(messages.validationNtfyUrl),
        isValidURL
      ),
    topic: Yup.string()
      .when('enabled', {
        is: true,
        then: (schema) =>
          schema
            .nullable()
            .required(intl.formatMessage(messages.validationNtfyTopic)),
        otherwise: (schema) => schema.nullable(),
      })
      .defined(intl.formatMessage(messages.validationNtfyTopic)),
    priority: Yup.number().when('enabled', {
      is: true,
      then: (schema) =>
        schema
          .nullable()
          .min(1)
          .max(5)
          .required(intl.formatMessage(messages.validationPriorityRequired)),
      otherwise: (schema) => schema.nullable(),
    }),
  });

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  return (
    <Formik
      initialValues={{
        enabled: data?.enabled,
        embedPoster: data?.embedPoster,
        types: data?.types,
        url: data?.options.url,
        topic: data?.options.topic,
        tags: data?.options.tags ?? '',
        authMethodUsernamePassword: data?.options.authMethodUsernamePassword,
        username: data?.options.username,
        password: data?.options.password,
        authMethodToken: data?.options.authMethodToken,
        token: data?.options.token,
        priority: data?.options.priority,
        locale: data?.options.locale ?? 'en',
        approvalButtons: data?.options.approvalButtons ?? false,
        approveAsUserId: data?.options.approveAsUserId ?? 1,
      }}
      validationSchema={NotificationsNtfySchema}
      onSubmit={async (values) => {
        try {
          await axios.post('/api/v1/settings/notifications/ntfy', {
            enabled: values.enabled,
            embedPoster: values.embedPoster,
            types: values.types,
            options: {
              url: values.url,
              topic: values.topic,
              tags: values.tags,
              authMethodUsernamePassword: values.authMethodUsernamePassword,
              username: values.username,
              password: values.password,
              authMethodToken: values.authMethodToken,
              token: values.token,
              priority: Number(values.priority),
              locale: values.locale,
              approvalButtons: values.approvalButtons,
              approveAsUserId: Number(values.approveAsUserId),
            },
          });

          addToast(intl.formatMessage(messages.ntfysettingssaved), {
            appearance: 'success',
            autoDismiss: true,
          });
        } catch {
          addToast(intl.formatMessage(messages.ntfysettingsfailed), {
            appearance: 'error',
            autoDismiss: true,
          });
        } finally {
          revalidate();
        }
      }}
    >
      {({
        errors,
        touched,
        isSubmitting,
        values,
        isValid,
        setFieldValue,
        setFieldTouched,
      }) => {
        const testSettings = async () => {
          setIsTesting(true);
          let toastId: string | undefined;
          try {
            addToast(
              intl.formatMessage(messages.toastNtfyTestSending),
              {
                autoDismiss: false,
                appearance: 'info',
              },
              (id) => {
                toastId = id;
              }
            );
            await axios.post('/api/v1/settings/notifications/ntfy/test', {
              enabled: true,
              types: values.types,
              options: {
                url: values.url,
                topic: values.topic,
                tags: values.tags,
                authMethodUsernamePassword: values.authMethodUsernamePassword,
                username: values.username,
                password: values.password,
                authMethodToken: values.authMethodToken,
                token: values.token,
                priority: Number(values.priority),
                locale: values.locale,
              },
            });

            if (toastId) {
              removeToast(toastId);
            }
            addToast(intl.formatMessage(messages.toastNtfyTestSuccess), {
              autoDismiss: true,
              appearance: 'success',
            });
          } catch {
            if (toastId) {
              removeToast(toastId);
            }
            addToast(intl.formatMessage(messages.toastNtfyTestFailed), {
              autoDismiss: true,
              appearance: 'error',
            });
          } finally {
            setIsTesting(false);
          }
        };

        return (
          <Form className="section">
            <div className="form-row">
              <label htmlFor="enabled" className="checkbox-label">
                {intl.formatMessage(messages.agentenabled)}
                <span className="label-required">*</span>
              </label>
              <div className="form-input-area">
                <Field type="checkbox" id="enabled" name="enabled" />
              </div>
            </div>
            <div className="form-row">
              <label htmlFor="embedPoster" className="checkbox-label">
                {intl.formatMessage(messages.embedPoster)}
              </label>
              <div className="form-input-area">
                <Field type="checkbox" id="embedPoster" name="embedPoster" />
              </div>
            </div>
            <div className="form-row">
              <label htmlFor="url" className="text-label">
                {intl.formatMessage(messages.url)}
                <span className="label-required">*</span>
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <Field id="url" name="url" type="text" inputMode="url" />
                </div>
                {errors.url &&
                  touched.url &&
                  typeof errors.url === 'string' && (
                    <div className="error">{errors.url}</div>
                  )}
              </div>
            </div>
            <div className="form-row">
              <label htmlFor="topic" className="text-label">
                {intl.formatMessage(messages.topic)}
                <span className="label-required">*</span>
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <Field id="topic" name="topic" type="text" />
                </div>
                {errors.topic &&
                  touched.topic &&
                  typeof errors.topic === 'string' && (
                    <div className="error">{errors.topic}</div>
                  )}
              </div>
            </div>
            <div className="form-row">
              <label htmlFor="tags" className="text-label">
                {intl.formatMessage(messages.tags)}
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <Field
                    id="tags"
                    name="tags"
                    type="text"
                    placeholder={intl.formatMessage(messages.tagsPlaceholder)}
                  />
                </div>
              </div>
            </div>
            <div className="form-row">
              <label
                htmlFor="authMethodUsernamePassword"
                className="checkbox-label"
              >
                <span className="mr-2">
                  {intl.formatMessage(messages.usernamePasswordAuth)}
                </span>
              </label>
              <div className="form-input-area">
                <Field
                  type="checkbox"
                  id="authMethodUsernamePassword"
                  name="authMethodUsernamePassword"
                  disabled={values.authMethodToken}
                  onChange={() => {
                    setFieldValue(
                      'authMethodUsernamePassword',
                      !values.authMethodUsernamePassword
                    );
                  }}
                />
              </div>
            </div>
            {values.authMethodUsernamePassword && (
              <div className="ml-4 mr-2">
                <div className="form-row">
                  <label htmlFor="username" className="text-label">
                    {intl.formatMessage(messages.username)}
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field id="username" name="username" type="text" />
                    </div>
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="password" className="text-label">
                    {intl.formatMessage(messages.password)}
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <SensitiveInput
                        as="field"
                        id="password"
                        name="password"
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
            <div className="form-row">
              <label htmlFor="authMethodToken" className="checkbox-label">
                <span className="mr-2">
                  {intl.formatMessage(messages.tokenAuth)}
                </span>
              </label>
              <div className="form-input-area">
                <Field
                  type="checkbox"
                  id="authMethodToken"
                  name="authMethodToken"
                  disabled={values.authMethodUsernamePassword}
                  onChange={() => {
                    setFieldValue('authMethodToken', !values.authMethodToken);
                  }}
                />
              </div>
            </div>
            {values.authMethodToken && (
              <div className="form-row ml-4 mr-2">
                <label htmlFor="token" className="text-label">
                  {intl.formatMessage(messages.token)}
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <SensitiveInput as="field" id="token" name="token" />
                  </div>
                </div>
              </div>
            )}
            <div className="form-row">
              <label htmlFor="priority" className="text-label">
                {intl.formatMessage(messages.priority)}
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <Field as="select" id="priority" name="priority">
                    <option value={1}>
                      {intl.formatMessage(messages.priorityMin)}
                    </option>
                    <option value={2}>
                      {intl.formatMessage(messages.priorityLow)}
                    </option>
                    <option value={3}>
                      {intl.formatMessage(messages.priorityDefault)}
                    </option>
                    <option value={4}>
                      {intl.formatMessage(messages.priorityHigh)}
                    </option>
                    <option value={5}>
                      {intl.formatMessage(messages.priorityUrgent)}
                    </option>
                  </Field>
                </div>
              </div>
            </div>
            <div className="form-row">
              <label htmlFor="locale" className="text-label">
                {intl.formatMessage(globalMessages.notificationLocale)}
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <Field as="select" id="locale" name="locale">
                    {(
                      Object.keys(
                        availableLanguages
                      ) as (keyof typeof availableLanguages)[]
                    ).map((key) => (
                      <option
                        key={key}
                        value={availableLanguages[key].code}
                        lang={availableLanguages[key].code}
                      >
                        {availableLanguages[key].display}
                      </option>
                    ))}
                  </Field>
                </div>
              </div>
            </div>
            <div className="form-row">
              <label htmlFor="approvalButtons" className="checkbox-label">
                <span>{intl.formatMessage(messages.approvalButtons)}</span>
                <span className="label-tip">
                  {intl.formatMessage(messages.approvalButtonsTip)}
                </span>
              </label>
              <div className="form-input-area">
                <Field
                  type="checkbox"
                  id="approvalButtons"
                  name="approvalButtons"
                  disabled={!applicationUrl && !values.approvalButtons}
                />
                {!applicationUrl && (
                  <div className="error">
                    {intl.formatMessage(messages.approvalButtonsNeedUrl)}
                  </div>
                )}
              </div>
            </div>
            {values.approvalButtons && (
              <div className="form-row ml-4 mr-2">
                <label htmlFor="approveAsUserId" className="text-label">
                  {intl.formatMessage(messages.approveAs)}
                  <span className="label-tip">
                    {intl.formatMessage(messages.approveAsTip)}
                  </span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <Field
                      as="select"
                      id="approveAsUserId"
                      name="approveAsUserId"
                    >
                      {/* The saved account stays listed, even after losing
                          the permission, so the choice shown is the one kept. */}
                      {!approvers.some(
                        (user) => user.id === Number(values.approveAsUserId)
                      ) && (
                        <option value={values.approveAsUserId}>
                          {users?.results.find(
                            (user) => user.id === Number(values.approveAsUserId)
                          )?.displayName ?? `#${values.approveAsUserId}`}
                        </option>
                      )}
                      {approvers.map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.displayName}
                        </option>
                      ))}
                    </Field>
                  </div>
                </div>
              </div>
            )}
            <NotificationTypeSelector
              currentTypes={values.enabled ? values.types || 0 : 0}
              onUpdate={(newTypes) => {
                setFieldValue('types', newTypes);
                setFieldTouched('types');

                if (newTypes) {
                  setFieldValue('enabled', true);
                }
              }}
              error={
                values.enabled && !values.types && touched.types
                  ? intl.formatMessage(messages.validationTypes)
                  : undefined
              }
            />
            <SaveBar>
              <div className="flex justify-end">
                <span className="ml-3 inline-flex rounded-md shadow-sm">
                  <Button
                    buttonType="warning"
                    disabled={isSubmitting || !isValid || isTesting}
                    onClick={(e) => {
                      e.preventDefault();
                      testSettings();
                    }}
                  >
                    <BeakerIcon />
                    <span>
                      {isTesting
                        ? intl.formatMessage(globalMessages.testing)
                        : intl.formatMessage(globalMessages.test)}
                    </span>
                  </Button>
                </span>
                <span className="ml-3 inline-flex rounded-md shadow-sm">
                  <Button
                    buttonType="primary"
                    type="submit"
                    disabled={
                      isSubmitting ||
                      !isValid ||
                      isTesting ||
                      (values.enabled && !values.types)
                    }
                  >
                    <ArrowDownOnSquareIcon />
                    <span>
                      {isSubmitting
                        ? intl.formatMessage(globalMessages.saving)
                        : intl.formatMessage(globalMessages.save)}
                    </span>
                  </Button>
                </span>
              </div>
            </SaveBar>
          </Form>
        );
      }}
    </Formik>
  );
};

export default NotificationsNtfy;
