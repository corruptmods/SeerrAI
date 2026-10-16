import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import AdvancedSection from '@app/components/Settings/AdvancedSection';
import CreditPanel from '@app/components/Settings/SettingsAi/CreditPanel';
import type { ModelInfo } from '@app/components/Settings/SettingsAi/ModelPicker';
import ModelPicker from '@app/components/Settings/SettingsAi/ModelPicker';
import { aiErrorMessage } from '@app/hooks/useAi';
import useMediaQuery from '@app/hooks/useMediaQuery';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowDownOnSquareIcon,
  ArrowPathIcon,
  BeakerIcon,
  CheckCircleIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import type { AiFeature } from '@server/constants/features';
import { AI_FEATURES } from '@server/constants/features';
import axios from 'axios';
import { useCallback, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { useSWRConfig } from 'swr';

const messages = defineMessages('components.Settings.SettingsAi', {
  ai: 'AI',
  description:
    'A model for the AI features. Each feature sends the model only what it needs, with a small limit on the answer, and repeated questions are answered from memory at no cost. Turn features on or off, for everyone, in Features.',
  enabled: 'Enable AI Features',
  provider: 'Provider',
  anthropic: 'Claude (Anthropic)',
  openai: 'OpenAI, or a compatible server',
  apiKey: 'API Key',
  apiKeyTip: 'Never shown again once saved.',
  apiKeyAgain:
    'Enter the key for this provider. A saved key is only used with the provider and address it was saved for.',
  apiKeyOptional: 'Optional for a server at home.',
  keySaved: 'Key saved',
  keyRemoving: 'Will be removed when you save',
  replace: 'Replace',
  remove: 'Remove',
  undo: 'Undo',
  keepSaved: 'Keep the saved key',
  pasteKey: 'Paste the API key',
  baseUrl: 'Server Address',
  baseUrlTip:
    'Leave empty for OpenAI. For another service or a server at home (Ollama, LM Studio), its OpenAI-compatible address, such as http://your-server:11434/v1. A home server keeps everything in your network.',
  model: 'Model',
  modelTip:
    'Used by every feature without its own model below. Smaller models are cheaper and faster, and are enough for most features.',
  loadModels: 'Reload the Model List',
  chooseModel: 'Choose a model',
  typeModel: 'Type a model name, or add a key to list them',
  typeModelShort: 'Type a model name',
  modelsFailed: 'The model list could not be loaded: {reason}',
  featureModels: 'Model for Each Feature',
  featureModelsTip:
    'Optional. A cheaper model for simple features, or a stronger one where it matters. Empty uses the model above.',
  sameAsAbove: 'Same as above',
  dailyLimit: 'Daily Limit per Person',
  dailyLimitTip:
    'AI answers each person gets per day. 0 is no limit. Admins are not limited, and answers from memory do not count.',
  test: 'Test',
  testOk: '{model} answered.',
  saved: 'AI settings saved.',
  failed: 'The settings could not be saved.',
  aiChat: 'AI Search',
  aiReasons: 'Why These Suggestions',
  aiPicker: 'Pick for the Room',
  aiRecap: 'Catch Me Up',
  aiDeletionReview: 'Review Deletions',
  aiIssueTriage: 'Suggest Issue Fixes',
  aiLogs: 'Explain Logs',
  aiBackfill: 'Backfill Second Opinion',
  aiAgent: 'Admin Agent',
  privacy:
    'Titles people have watched are sent to the provider for AI Search, suggestions and picks, but never account names or emails. Issue comments are sent as written. Choose a server at home to keep everything in your network.',
});

interface AiSettingsForm {
  enabled: boolean;
  provider: 'anthropic' | 'openai';
  apiKey: string;
  hasApiKey?: boolean;
  removeApiKey?: boolean;
  baseUrl: string;
  model: string;
  featureModels: Partial<Record<AiFeature, string>>;
  dailyLimit: number;
}

const SettingsAi = () => {
  const intl = useIntl();
  // The whole hint does not fit the model field on a phone.
  const wide = useMediaQuery('(min-width: 640px)');
  const { addToast } = useToasts();
  const { mutate: globalMutate } = useSWRConfig();
  const { data, mutate } = useSWR<AiSettingsForm>('/api/v1/settings/ai');
  const [form, setForm] = useState<AiSettingsForm>();
  // The list belongs to one provider and address, and is not shown for any
  // other.
  const [models, setModels] = useState<{ for: string; list: ModelInfo[] }>({
    for: '',
    list: [],
  });
  const [modelsProblem, setModelsProblem] = useState<string>();
  const [listing, setListing] = useState(false);
  // A typed key is used to list models once it has been entered, not on
  // every keystroke.
  const [enteredKey, setEnteredKey] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState<'save' | 'test'>();
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    if (data && !form) {
      setForm({ ...data, apiKey: '' });
    }
  }, [data, form]);

  // Which list the current choices call for: the provider and address, and
  // the key it would be fetched with.
  const listFor = form
    ? [
        form.provider,
        form.provider === 'openai' ? form.baseUrl.trim() : '',
        enteredKey.trim() ? `typed:${enteredKey.trim()}` : 'saved',
      ].join('|')
    : '';
  const listable =
    !!form &&
    (!!enteredKey.trim() ||
      (!!form.hasApiKey &&
        !!data &&
        form.provider === data.provider &&
        (form.provider === 'openai' ? form.baseUrl : '') === data.baseUrl &&
        !form.removeApiKey &&
        !replacing) ||
      (form.provider === 'openai' && !!form.baseUrl.trim()));

  const listModels = useCallback(
    async (current: AiSettingsForm, key: string, forList: string) => {
      setListing(true);
      setModelsProblem(undefined);
      try {
        const response = await axios.post<ModelInfo[]>(
          '/api/v1/settings/ai/models',
          {
            enabled: current.enabled,
            provider: current.provider,
            apiKey: key,
            removeApiKey: false,
            baseUrl: current.provider === 'openai' ? current.baseUrl : '',
            model: current.model,
            featureModels: current.featureModels,
            dailyLimit: current.dailyLimit,
          }
        );
        setModels({ for: forList, list: response.data });
      } catch (e) {
        // Remembered as tried, so a failure is shown, not retried in a loop.
        setModels({ for: forList, list: [] });
        setModelsProblem(
          intl.formatMessage(messages.modelsFailed, {
            reason: aiErrorMessage(e, intl.formatMessage(messages.failed)),
          })
        );
      } finally {
        setListing(false);
      }
    },
    [intl]
  );

  // The list loads by itself whenever there is a key it can be fetched with:
  // on opening the page with one saved, after a key is entered, or when the
  // provider or address changes. Typing an address waits for a pause.
  useEffect(() => {
    if (!form || !listable || models.for === listFor) {
      return;
    }
    const timer = setTimeout(
      () => listModels(form, enteredKey.trim(), listFor),
      400
    );
    return () => clearTimeout(timer);
    // The form's other fields do not change which list is wanted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listFor, listable, models.for, listModels]);

  if (!form) {
    return <LoadingSpinner />;
  }

  // The saved key only goes to the provider and address it was saved for.
  const sameTarget =
    !!data &&
    form.provider === data.provider &&
    (form.provider === 'openai' ? form.baseUrl : '') === data.baseUrl;
  const isLocal = form.provider === 'openai' && !!form.baseUrl.trim();
  const modelList = models.for === listFor ? models.list : [];

  const set = <K extends keyof AiSettingsForm>(
    key: K,
    value: AiSettingsForm[K]
  ) => setForm({ ...form, [key]: value });

  const payload = () => ({
    enabled: form.enabled,
    provider: form.provider,
    apiKey: form.apiKey,
    removeApiKey: !!form.removeApiKey,
    baseUrl: form.provider === 'openai' ? form.baseUrl : '',
    model: form.model,
    featureModels: form.featureModels,
    dailyLimit: form.dailyLimit,
  });

  const run = async (kind: 'save' | 'test') => {
    setBusy(kind);
    setProblem(undefined);
    try {
      if (kind === 'test') {
        const response = await axios.post<{ model: string }>(
          '/api/v1/settings/ai/test',
          payload()
        );
        addToast(
          intl.formatMessage(messages.testOk, { model: response.data.model }),
          { appearance: 'success', autoDismiss: true }
        );
      } else {
        const response = await axios.post<AiSettingsForm>(
          '/api/v1/settings/ai',
          payload()
        );
        await mutate(response.data, { revalidate: false });
        setForm({ ...response.data, apiKey: '' });
        setEnteredKey('');
        setReplacing(false);
        await globalMutate('/api/v1/settings/public');
        // Another provider starts its credit afresh.
        await globalMutate('/api/v1/settings/ai/credit');
        addToast(intl.formatMessage(messages.saved), {
          appearance: 'success',
          autoDismiss: true,
        });
      }
    } catch (e) {
      setProblem(aiErrorMessage(e, intl.formatMessage(messages.failed)));
    } finally {
      setBusy(undefined);
    }
  };

  const changeProvider = (provider: 'anthropic' | 'openai') => {
    // Models are named differently by each provider, and a key only works
    // with its own: what was chosen or typed for the other one is cleared
    // rather than left to fail, or sent where it does not belong.
    setForm({
      ...form,
      provider,
      apiKey: '',
      model: '',
      featureModels: {},
      removeApiKey: false,
    });
    setEnteredKey('');
    setReplacing(false);
  };

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.ai),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.ai)}</h3>
        <p className="description">
          {intl.formatMessage(messages.description)}
        </p>
      </div>
      <div className="section">
        <Alert title={intl.formatMessage(messages.privacy)} type="info" />
        {problem && <Alert title={problem} type="error" />}
        <form
          className="section"
          onSubmit={(e) => {
            e.preventDefault();
            run('save');
          }}
        >
          <div className="form-row">
            <label htmlFor="aiEnabled" className="checkbox-label">
              {intl.formatMessage(messages.enabled)}
            </label>
            <div className="form-input-area">
              <input
                type="checkbox"
                id="aiEnabled"
                checked={form.enabled}
                onChange={(e) => set('enabled', e.target.checked)}
              />
            </div>
          </div>
          <div className="form-row">
            <label htmlFor="aiProvider" className="text-label">
              {intl.formatMessage(messages.provider)}
            </label>
            <div className="form-input-area">
              <div className="form-input-field">
                <select
                  id="aiProvider"
                  value={form.provider}
                  onChange={(e) =>
                    changeProvider(e.target.value as 'anthropic' | 'openai')
                  }
                >
                  <option value="anthropic">
                    {intl.formatMessage(messages.anthropic)}
                  </option>
                  <option value="openai">
                    {intl.formatMessage(messages.openai)}
                  </option>
                </select>
              </div>
            </div>
          </div>
          {form.provider === 'openai' && (
            <div className="form-row">
              <label htmlFor="aiBaseUrl" className="text-label">
                {intl.formatMessage(messages.baseUrl)}
                <span className="label-tip">
                  {intl.formatMessage(messages.baseUrlTip)}
                </span>
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <input
                    id="aiBaseUrl"
                    type="text"
                    inputMode="url"
                    placeholder="https://api.openai.com/v1"
                    value={form.baseUrl}
                    onChange={(e) => set('baseUrl', e.target.value)}
                  />
                </div>
              </div>
            </div>
          )}
          <div className="form-row">
            <label htmlFor="aiApiKey" className="text-label">
              {intl.formatMessage(messages.apiKey)}
              <span className="label-tip">
                {intl.formatMessage(
                  isLocal
                    ? messages.apiKeyOptional
                    : form.hasApiKey && !sameTarget
                      ? messages.apiKeyAgain
                      : messages.apiKeyTip
                )}
              </span>
            </label>
            <div className="form-input-area">
              {form.hasApiKey && sameTarget && !replacing ? (
                <div className="flex flex-wrap items-center gap-2">
                  <div
                    id="aiApiKey"
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-gray-500 bg-gray-700 px-3 py-2 text-sm text-white"
                  >
                    {form.removeApiKey ? (
                      <>
                        <TrashIcon className="h-5 w-5 flex-none text-red-400" />
                        <span>{intl.formatMessage(messages.keyRemoving)}</span>
                      </>
                    ) : (
                      <>
                        <CheckCircleIcon className="h-5 w-5 flex-none text-green-400" />
                        <span>{intl.formatMessage(messages.keySaved)}</span>
                      </>
                    )}
                  </div>
                  {form.removeApiKey ? (
                    <Button
                      type="button"
                      buttonSize="sm"
                      onClick={() => set('removeApiKey', false)}
                    >
                      {intl.formatMessage(messages.undo)}
                    </Button>
                  ) : (
                    <>
                      <Button
                        type="button"
                        buttonSize="sm"
                        onClick={() => setReplacing(true)}
                      >
                        {intl.formatMessage(messages.replace)}
                      </Button>
                      <Button
                        type="button"
                        buttonSize="sm"
                        buttonType="danger"
                        onClick={() => set('removeApiKey', true)}
                      >
                        <TrashIcon />
                        <span>{intl.formatMessage(messages.remove)}</span>
                      </Button>
                    </>
                  )}
                </div>
              ) : (
                <>
                  <div className="form-input-field">
                    <SensitiveInput
                      id="aiApiKey"
                      autoComplete="off"
                      placeholder={intl.formatMessage(messages.pasteKey)}
                      value={form.apiKey}
                      onChange={(e) => set('apiKey', e.target.value)}
                      onBlur={() => setEnteredKey(form.apiKey)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          // Loads the model list; saving is a separate step.
                          e.preventDefault();
                          setEnteredKey(form.apiKey);
                        }
                      }}
                      className="rounded-l-only"
                    />
                  </div>
                  {replacing && (
                    <button
                      type="button"
                      className="mt-2 text-sm text-gray-400 hover:text-white"
                      onClick={() => {
                        setReplacing(false);
                        setEnteredKey('');
                        set('apiKey', '');
                      }}
                    >
                      {intl.formatMessage(messages.keepSaved)}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
          <div className="form-row">
            <label htmlFor="aiModel" className="text-label">
              {intl.formatMessage(messages.model)}
              <span className="label-tip">
                {intl.formatMessage(messages.modelTip)}
              </span>
            </label>
            <div className="form-input-area">
              <div className="flex items-start gap-2">
                <ModelPicker
                  id="aiModel"
                  value={form.model}
                  onChange={(model) => set('model', model)}
                  models={modelList}
                  loading={listing}
                  emptyLabel={intl.formatMessage(
                    modelList.length
                      ? messages.chooseModel
                      : wide
                        ? messages.typeModel
                        : messages.typeModelShort
                  )}
                />
                {listable && (
                  <button
                    type="button"
                    className="flex h-[38px] w-[38px] flex-none items-center justify-center rounded-md border border-gray-500 bg-gray-700 text-gray-300 transition hover:text-white disabled:opacity-50"
                    onClick={() => listModels(form, enteredKey.trim(), listFor)}
                    disabled={listing}
                    aria-label={intl.formatMessage(messages.loadModels)}
                    title={intl.formatMessage(messages.loadModels)}
                  >
                    <ArrowPathIcon
                      className={`h-5 w-5 ${listing ? 'animate-spin' : ''}`}
                    />
                  </button>
                )}
              </div>
              {modelsProblem && (
                <p className="mt-2 text-sm text-red-400" role="alert">
                  {modelsProblem}
                </p>
              )}
            </div>
          </div>
          <div className="form-row">
            <label htmlFor="aiDailyLimit" className="text-label">
              {intl.formatMessage(messages.dailyLimit)}
              <span className="label-tip">
                {intl.formatMessage(messages.dailyLimitTip)}
              </span>
            </label>
            <div className="form-input-area">
              {/* A text field with a number pad, as elsewhere in settings:
                  the theme styles text fields, not number fields. */}
              <input
                id="aiDailyLimit"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="off"
                className="short"
                value={String(form.dailyLimit)}
                onChange={(e) =>
                  set(
                    'dailyLimit',
                    Math.min(
                      10000,
                      Number(e.target.value.replace(/\D/g, '')) || 0
                    )
                  )
                }
              />
            </div>
          </div>
          <AdvancedSection>
            <div className="form-row">
              <span className="group-label sm:mt-2">
                {intl.formatMessage(messages.featureModels)}
                <span className="label-tip">
                  {intl.formatMessage(messages.featureModelsTip)}
                </span>
              </span>
              <div className="form-input-area space-y-3">
                {AI_FEATURES.map((feature) => (
                  <div
                    key={feature}
                    className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3"
                  >
                    <label
                      htmlFor={`aiModel-${feature}`}
                      className="flex-none text-sm text-gray-300 sm:w-44"
                    >
                      {intl.formatMessage(messages[feature])}
                    </label>
                    <ModelPicker
                      id={`aiModel-${feature}`}
                      value={form.featureModels[feature] ?? ''}
                      onChange={(model) =>
                        set('featureModels', {
                          ...form.featureModels,
                          [feature]: model,
                        })
                      }
                      models={modelList}
                      loading={listing}
                      emptyLabel={intl.formatMessage(messages.sameAsAbove)}
                    />
                  </div>
                ))}
              </div>
            </div>
          </AdvancedSection>
          <div className="actions">
            <div className="flex justify-end">
              <span className="ml-3 inline-flex rounded-md shadow-sm">
                <Button
                  buttonType="warning"
                  type="button"
                  disabled={!!busy || !form.model}
                  onClick={() => run('test')}
                >
                  <BeakerIcon />
                  <span>{intl.formatMessage(messages.test)}</span>
                </Button>
              </span>
              <span className="ml-3 inline-flex rounded-md shadow-sm">
                <Button buttonType="primary" type="submit" disabled={!!busy}>
                  <ArrowDownOnSquareIcon />
                  <span>
                    {intl.formatMessage(
                      busy === 'save'
                        ? globalMessages.saving
                        : globalMessages.save
                    )}
                  </span>
                </Button>
              </span>
            </div>
          </div>
        </form>
      </div>
      {data?.hasApiKey && <CreditPanel />}
    </>
  );
};

export default SettingsAi;
