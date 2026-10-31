import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import SaveBar from '@app/components/Common/SaveBar';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import { aiErrorMessage } from '@app/hooks/useAi';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowDownOnSquareIcon,
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import type { CreditReport } from '@server/lib/ai/credit';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Settings.SettingsAi.CreditPanel', {
  credit: 'Credit',
  description:
    'Providers don’t share your balance, so it’s your entered balance minus spending since.',
  outOfCredit:
    'The account ran out of credit on {date}. AI features fail until it’s topped up.',
  addCredit: 'Add credit',
  spentThisMonth: 'Spent this month',
  spentSince: 'Spent since {date}',
  left: 'Left',
  leftUnknown: 'Enter your balance below',
  fromProvider:
    "From {provider}'s own spending report: everything the account spent, counted in whole days (UTC).",
  estimated:
    'Estimated from Seerr AI’s own requests at the prices below. Other use of this account isn’t counted.',
  unpriced: 'Not counted, as there is no price for it: {models}.',
  providerProblem:
    "{provider}'s spending report could not be read, so this is Seerr AI's own estimate: {reason}",
  balance: 'Balance Now',
  balanceTip:
    'In US dollars, from the billing page. Spending after you save is taken off.',
  balanceSet: 'Last entered: {amount} on {date}.',
  adminKey: 'Admin Key',
  adminKeyOpenAi:
    'Optional admin key (sk-admin…) to read OpenAI’s spending report. It can manage the organization, so it’s hidden once saved.',
  adminKeyAnthropic:
    'Optional Admin API key (sk-ant-admin…) to read Anthropic’s cost report. Organization accounts only. Hidden once saved.',
  keySaved: 'Admin key saved',
  keyRemoving: 'Will be removed when you save',
  replace: 'Replace',
  remove: 'Remove',
  undo: 'Undo',
  keepSaved: 'Keep the saved key',
  pasteKey: 'Paste the admin key',
  prices: 'Prices',
  pricesTip:
    'US dollars per million tokens. Used for estimates without an admin key; thinking counts as output.',
  pricing: 'Pricing page',
  input: 'Input',
  output: 'Output',
  usage:
    '{requests, plural, one {# request} other {# requests}} this month · {input} in, {output} out',
  saved: 'Credit settings saved.',
  failed: 'The credit settings could not be saved.',
});

const LINKS = {
  openai: {
    name: 'OpenAI',
    billing:
      'https://platform.openai.com/settings/organization/billing/overview',
    pricing: 'https://openai.com/api/pricing/',
  },
  anthropic: {
    name: 'Anthropic',
    billing: 'https://platform.claude.com/settings/billing',
    pricing: 'https://platform.claude.com/docs/en/about-claude/pricing',
  },
} as const;

type PriceFields = Record<string, { input: string; output: string }>;

const toFields = (prices: CreditReport['prices']): PriceFields =>
  Object.fromEntries(
    Object.entries(prices).map(([model, p]) => [
      model,
      { input: String(p.input), output: String(p.output) },
    ])
  );

/** A typed amount: digits and one decimal point. */
const decimal = (value: string) =>
  value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1');

const CreditPanel = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data: report, mutate } = useSWR<CreditReport>(
    '/api/v1/settings/ai/credit'
  );
  const [balance, setBalance] = useState<string>();
  const [adminKey, setAdminKey] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [removeAdminKey, setRemoveAdminKey] = useState(false);
  const [prices, setPrices] = useState<PriceFields>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    if (report && !prices) {
      setPrices(toFields(report.prices));
    }
  }, [report, prices]);

  if (!report?.billedBy || !prices) {
    return null;
  }
  const links = LINKS[report.billedBy];

  const money = (value: number) =>
    intl.formatNumber(value, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      // Cheap models spend fractions of a cent.
      maximumFractionDigits: Math.abs(value) < 1 ? 4 : 2,
    });
  const day = (iso: string) =>
    intl.formatDate(iso, { year: 'numeric', month: 'short', day: 'numeric' });

  const save = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      const priced = Object.entries(prices).filter(
        ([, p]) => p.input.trim() !== '' && p.output.trim() !== ''
      );
      const response = await axios.post<CreditReport>(
        '/api/v1/settings/ai/credit',
        {
          ...(adminKey.trim() ? { adminKey: adminKey.trim() } : {}),
          ...(removeAdminKey ? { removeAdminKey: true } : {}),
          ...(balance !== undefined
            ? { balance: balance.trim() === '' ? null : Number(balance) }
            : {}),
          prices: Object.fromEntries(
            priced.map(([model, p]) => [
              model,
              { input: Number(p.input), output: Number(p.output) },
            ])
          ),
        }
      );
      await mutate(response.data, { revalidate: false });
      setPrices(toFields(response.data.prices));
      setBalance(undefined);
      setAdminKey('');
      setReplacing(false);
      setRemoveAdminKey(false);
      addToast(intl.formatMessage(messages.saved), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch (e) {
      setProblem(aiErrorMessage(e, intl.formatMessage(messages.failed)));
    } finally {
      setBusy(false);
    }
  };

  const tiles = [
    {
      label: intl.formatMessage(messages.spentThisMonth),
      value: money(report.spentThisMonth),
    },
    ...(report.balanceAt && report.spentSinceBalance !== null
      ? [
          {
            label: intl.formatMessage(messages.spentSince, {
              date: day(report.balanceAt),
            }),
            value: money(report.spentSinceBalance),
          },
        ]
      : []),
    {
      label: intl.formatMessage(messages.left),
      value:
        report.remaining !== null
          ? money(report.remaining)
          : intl.formatMessage(messages.leftUnknown),
      muted: report.remaining === null,
    },
  ];

  return (
    <div className="mt-10">
      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.credit)}</h3>
        <p className="description">
          {intl.formatMessage(messages.description)}
        </p>
      </div>
      <div className="section">
        {report.outOfCreditAt && (
          <Alert
            type="error"
            title={intl.formatMessage(messages.outOfCredit, {
              date: day(report.outOfCreditAt),
            })}
          >
            <a
              href={links.billing}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-semibold text-strong underline"
            >
              {intl.formatMessage(messages.addCredit)}
              <ArrowTopRightOnSquareIcon className="h-4 w-4" />
            </a>
          </Alert>
        )}
        {report.providerProblem && (
          <Alert
            type="warning"
            title={intl.formatMessage(messages.providerProblem, {
              provider: links.name,
              reason: report.providerProblem,
            })}
          />
        )}
        {problem && <Alert title={problem} type="error" />}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {tiles.map((tile) => (
            <div
              key={tile.label}
              className="rounded-md border border-gray-700 bg-gray-800 px-4 py-3"
            >
              <div className="text-sm text-gray-400">{tile.label}</div>
              <div
                className={`mt-1 font-semibold ${
                  tile.muted ? 'text-sm text-gray-400' : 'text-2xl text-strong'
                }`}
              >
                {tile.value}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-sm text-gray-400">
          {report.source === 'provider'
            ? intl.formatMessage(messages.fromProvider, {
                provider: links.name,
              })
            : intl.formatMessage(messages.estimated)}
          {report.unpriced.length > 0 && (
            <>
              {' '}
              {intl.formatMessage(messages.unpriced, {
                models: report.unpriced.join(', '),
              })}
            </>
          )}
        </p>

        <form
          className="section"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <div className="form-row">
            <label htmlFor="aiBalance" className="text-label">
              {intl.formatMessage(messages.balance)}
              <span className="label-tip">
                {intl.formatMessage(messages.balanceTip)}
              </span>
            </label>
            <div className="form-input-area">
              <input
                id="aiBalance"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                className="short"
                placeholder="0.00"
                value={balance ?? ''}
                onChange={(e) => setBalance(decimal(e.target.value))}
              />
              {report.balance !== null && report.balanceAt && (
                <p className="mt-2 text-sm text-gray-400">
                  {intl.formatMessage(messages.balanceSet, {
                    amount: money(report.balance),
                    date: day(report.balanceAt),
                  })}
                </p>
              )}
            </div>
          </div>

          <div className="form-row">
            <label htmlFor="aiAdminKey" className="text-label">
              {intl.formatMessage(messages.adminKey)}
              <span className="label-tip">
                {intl.formatMessage(
                  report.billedBy === 'openai'
                    ? messages.adminKeyOpenAi
                    : messages.adminKeyAnthropic
                )}
              </span>
            </label>
            <div className="form-input-area">
              {report.hasAdminKey && !replacing ? (
                <div className="flex flex-wrap items-center gap-2">
                  <div
                    id="aiAdminKey"
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-field-border bg-field px-3 py-2 text-sm text-strong"
                  >
                    {removeAdminKey ? (
                      <>
                        <TrashIcon className="h-5 w-5 flex-none text-red-400 light:text-danger-text" />
                        <span>{intl.formatMessage(messages.keyRemoving)}</span>
                      </>
                    ) : (
                      <>
                        <CheckCircleIcon className="h-5 w-5 flex-none text-success-text" />
                        <span>{intl.formatMessage(messages.keySaved)}</span>
                      </>
                    )}
                  </div>
                  {removeAdminKey ? (
                    <Button
                      type="button"
                      buttonSize="sm"
                      onClick={() => setRemoveAdminKey(false)}
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
                        onClick={() => setRemoveAdminKey(true)}
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
                      id="aiAdminKey"
                      autoComplete="off"
                      placeholder={intl.formatMessage(messages.pasteKey)}
                      value={adminKey}
                      onChange={(e) => setAdminKey(e.target.value)}
                      className="rounded-l-only"
                    />
                  </div>
                  {replacing && (
                    <button
                      type="button"
                      className="mt-2 text-sm text-gray-400 hover:text-strong"
                      onClick={() => {
                        setReplacing(false);
                        setAdminKey('');
                      }}
                    >
                      {intl.formatMessage(messages.keepSaved)}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          {report.models.length > 0 && (
            <div className="form-row">
              <span className="group-label sm:mt-2">
                {intl.formatMessage(messages.prices)}
                <span className="label-tip">
                  {intl.formatMessage(messages.pricesTip)}{' '}
                  <a
                    href={links.pricing}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 underline hover:text-strong"
                  >
                    {intl.formatMessage(messages.pricing)}
                    <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
                  </a>
                </span>
              </span>
              <div className="form-input-area space-y-4">
                {report.models.map((m) => {
                  const fields = prices[m.model] ?? { input: '', output: '' };
                  const setField = (key: 'input' | 'output', value: string) =>
                    setPrices({
                      ...prices,
                      [m.model]: { ...fields, [key]: decimal(value) },
                    });
                  return (
                    <div key={m.model}>
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <span className="break-all text-sm font-semibold text-gray-200">
                          {m.model}
                        </span>
                        {m.cost !== null && m.requests > 0 && (
                          <span className="text-sm text-gray-300">
                            {money(m.cost)}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-400">
                        {intl.formatMessage(messages.usage, {
                          requests: m.requests,
                          input: intl.formatNumber(m.inputTokens),
                          output: intl.formatNumber(m.outputTokens),
                        })}
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-3 sm:max-w-sm">
                        {(['input', 'output'] as const).map((key) => (
                          <label key={key} className="block">
                            <span className="text-xs text-gray-400">
                              {intl.formatMessage(messages[key])}
                            </span>
                            <input
                              type="text"
                              inputMode="decimal"
                              autoComplete="off"
                              placeholder="0.00"
                              aria-label={`${m.model} ${intl.formatMessage(messages[key])}`}
                              value={fields[key]}
                              onChange={(e) => setField(key, e.target.value)}
                            />
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <SaveBar>
            <div className="flex justify-end">
              <span className="ml-3 inline-flex rounded-md shadow-sm">
                <Button buttonType="primary" type="submit" disabled={busy}>
                  <ArrowDownOnSquareIcon />
                  <span>
                    {intl.formatMessage(
                      busy ? globalMessages.saving : globalMessages.save
                    )}
                  </span>
                </Button>
              </span>
            </div>
          </SaveBar>
        </form>
      </div>
    </div>
  );
};

export default CreditPanel;
