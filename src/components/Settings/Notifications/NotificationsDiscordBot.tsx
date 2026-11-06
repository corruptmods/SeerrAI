import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowDownOnSquareIcon,
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  BeakerIcon,
  CheckIcon,
} from '@heroicons/react/24/outline';
import type {
  DiscordBotApprover,
  DiscordBotChannel,
  DiscordBotGuild,
  DiscordBotInfoResponse,
  DiscordBotSettingsResponse,
  DiscordBotTrouble,
  DiscordBotTroubleReason,
} from '@server/interfaces/api/discordBotInterfaces';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.Settings.Notifications.DiscordBot',
  {
    intro:
      'Seerr AI can run its own Discord bot, which posts each request waiting for approval to a channel with Approve and Decline buttons. It connects out to Discord, so no port has to be open. It’s separate from Discord notifications, which keep working as they are.',
    statusOff: 'The Discord bot is off.',
    statusConnecting: 'Connecting to Discord…',
    statusConnected: 'Connected to Discord as {name}.',
    statusRetrying:
      'Lost the connection to Discord; trying again. Discord said: {detail}',
    statusToken:
      'Discord refused the bot token, so the bot stopped. Add a new token in step 2.',
    statusRefused:
      'Discord refused the connection, so the bot stopped. Save again to retry. Discord said: {detail}',
    statusPostFailed:
      'Connected, but the last request couldn’t be posted to the channel. Discord said: {detail}',
    step1Title: 'Create a Discord application',
    step1Text:
      'Open the <DevLink>Discord Developer Portal</DevLink>, choose <strong>New Application</strong>, give it any name (Seerr AI, say) and create it.',
    step2Title: 'Add the bot token',
    step2Text:
      'In the application, open <strong>Bot</strong>, choose <strong>Reset Token</strong> and copy the token, then paste it below. The bot needs no privileged gateway intents, so leave those off.',
    botToken: 'Bot Token',
    tokenSaved: 'Saved; leave blank to keep it',
    checkToken: 'Check and Save Token',
    checking: 'Checking…',
    botIs: 'The token works: this is {name}.',
    codeGrant:
      'Turn off <strong>Requires OAuth2 Code Grant</strong> on the Bot page, or Discord won’t let you invite it.',
    publicBot:
      'Turn off <strong>Public Bot</strong> on the Bot page, so only you can add the bot to a server.',
    tokenRefused:
      'Discord refused this token. Choose Reset Token again and copy the new one.',
    unreachable: 'Couldn’t reach Discord. Try again in a moment.',
    step3Title: 'Invite the bot to your server',
    step3Text:
      'Open the invite, pick your server and choose <strong>Authorize</strong>. The bot asks only to view channels, send messages, embed links and read message history.',
    invite: 'Open the Invite',
    inServers:
      'The bot is in {count, plural, one {# server} other {# servers}}.',
    noServers: 'The bot isn’t in a server yet. Invite it, then refresh.',
    refresh: 'Refresh',
    step4Title: 'Pick the channel',
    step4Text:
      'Requests waiting for approval are posted here. Everyone who can see the channel sees them, but only the approvers in the next step can use the buttons.',
    server: 'Server',
    channel: 'Channel',
    choose: 'Choose…',
    cantPost: '{channel} (the bot lacks permission here)',
    saveChannel: 'Save Channel',
    channelSaved: 'Channel saved.',
    step5Title: 'Link the approvers',
    step5Text:
      'A press counts as whoever made it, so each person who approves needs their Discord user ID in <strong>Profile → Settings → Notifications → Discord</strong>. To copy it, turn on <strong>Developer Mode</strong> in Discord (User Settings → Advanced), then right-click your name and choose <strong>Copy User ID</strong>. Presses from anyone else are refused and change nothing.',
    linked: 'Linked',
    notLinked: 'No Discord user ID',
    shared: 'Shares an ID with another approver, so neither works',
    step6Title: 'Send a test, then turn it on',
    step6Text:
      'The test message has the buttons too, but pressing them only says it’s a test and whether that Discord account is linked.',
    sendTest: 'Send Test Message',
    testSent: 'Test message sent.',
    testFailed: 'The test message wasn’t sent.',
    noAccess:
      'The bot can’t see that channel. Check it was invited to that server and that the channel lets it in.',
    noPermission:
      'The bot may not post in that channel. Give it Send Messages and Embed Links there.',
    enable: 'Enable Discord Bot',
    embedPoster: 'Embed Poster',
    saved: 'Discord bot settings saved.',
    saveFailed: 'Discord bot settings failed to save.',
    needsSetup: 'Finish steps 2 and 4 before turning it on.',
  }
);

const API = '/api/v1/settings/notifications/discord-bot';

const troubleOf = (e: unknown): DiscordBotTroubleReason | undefined =>
  axios.isAxiosError<DiscordBotTrouble>(e)
    ? e.response?.data?.reason
    : undefined;

const strong = (msg: React.ReactNode) => (
  <strong className="text-strong">{msg}</strong>
);

const NotificationsDiscordBot = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, error, mutate } = useSWR<DiscordBotSettingsResponse>(API, {
    // Follow the connection while it's changing.
    refreshInterval: (latest) =>
      latest?.status.state === 'connecting' ||
      latest?.status.state === 'retrying'
        ? 3000
        : 0,
  });
  const {
    data: info,
    error: infoError,
    mutate: mutateInfo,
  } = useSWR<DiscordBotInfoResponse>(data?.hasBotToken ? `${API}/bot` : null, {
    shouldRetryOnError: false,
  });
  const { data: guilds, mutate: mutateGuilds } = useSWR<DiscordBotGuild[]>(
    info ? `${API}/guilds` : null
  );
  const { data: approvers } = useSWR<DiscordBotApprover[]>(`${API}/approvers`);

  const [openStep, setOpenStep] = useState<number>();
  const [token, setToken] = useState('');
  const [checking, setChecking] = useState(false);
  const [tokenTrouble, setTokenTrouble] = useState<DiscordBotTroubleReason>();
  const [guildId, setGuildId] = useState('');
  const [channelId, setChannelId] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [embedPoster, setEmbedPoster] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testTrouble, setTestTrouble] = useState<DiscordBotTroubleReason>();

  const { data: channels, mutate: mutateChannels } = useSWR<
    DiscordBotChannel[]
  >(info && guildId ? `${API}/guilds/${guildId}/channels` : null);

  useEffect(() => {
    if (data) {
      setGuildId(data.options.guildId);
      setChannelId(data.options.channelId);
      setEnabled(data.enabled);
      setEmbedPoster(data.embedPoster);
    }
  }, [data]);

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  const done = [
    !!info,
    !!info,
    !!guilds?.length,
    !!data?.options.channelId,
    !!approvers?.some((approver) => approver.linked),
    !!data?.enabled,
  ];
  // The first step not done yet is open, until another is chosen.
  const firstUndone = done.findIndex((step) => !step);
  const current = openStep ?? (firstUndone < 0 ? done.length : firstUndone + 1);
  const ready = !!data?.hasBotToken && !!guildId && !!channelId;

  const save = async (values: { enabled: boolean }, saved: string) => {
    setSaving(true);
    try {
      await axios.post(API, {
        enabled: values.enabled,
        embedPoster,
        options: { guildId, channelId },
      });
      addToast(saved, { appearance: 'success', autoDismiss: true });
    } catch {
      addToast(intl.formatMessage(messages.saveFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setSaving(false);
      mutate();
    }
  };

  const checkToken = async () => {
    setChecking(true);
    setTokenTrouble(undefined);
    try {
      if (token) {
        mutateInfo(
          (
            await axios.put<DiscordBotInfoResponse>(`${API}/token`, {
              botToken: token,
            })
          ).data,
          { revalidate: false }
        );
        setToken('');
        await mutate();
      } else {
        await mutateInfo();
      }
    } catch (e) {
      setTokenTrouble(troubleOf(e) ?? 'other');
    } finally {
      setChecking(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    setTestTrouble(undefined);
    try {
      await axios.post(`${API}/test`, { channelId });
      addToast(intl.formatMessage(messages.testSent), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch (e) {
      setTestTrouble(troubleOf(e) ?? 'other');
    } finally {
      setTesting(false);
    }
  };

  const status = data?.status;
  const savedChannel = data?.options.channelId;
  const savedTokenTrouble = infoError
    ? (troubleOf(infoError) ?? 'other')
    : undefined;
  const shownTokenTrouble = tokenTrouble ?? savedTokenTrouble;

  const steps: { title: string; content: React.ReactNode }[] = [
    {
      title: intl.formatMessage(messages.step1Title),
      content: (
        <p>
          {intl.formatMessage(messages.step1Text, {
            strong,
            DevLink: (msg: React.ReactNode) => (
              <a
                href="https://discord.com/developers/applications"
                className="text-strong underline"
                target="_blank"
                rel="noreferrer"
              >
                {msg}
              </a>
            ),
          })}
        </p>
      ),
    },
    {
      title: intl.formatMessage(messages.step2Title),
      content: (
        <>
          <p>{intl.formatMessage(messages.step2Text, { strong })}</p>
          <div className="form-row">
            <label htmlFor="botToken" className="text-label">
              {intl.formatMessage(messages.botToken)}
              {data?.hasBotToken && (
                <span className="label-tip">
                  {intl.formatMessage(messages.tokenSaved)}
                </span>
              )}
            </label>
            <div className="form-input-area">
              <div className="form-input-field">
                <SensitiveInput
                  id="botToken"
                  name="botToken"
                  type="text"
                  autoComplete="off"
                  value={token}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setToken(e.target.value)
                  }
                />
              </div>
            </div>
          </div>
          <Button
            buttonType="primary"
            disabled={checking || (!token && !data?.hasBotToken)}
            onClick={(e) => {
              e.preventDefault();
              checkToken();
            }}
          >
            <CheckIcon />
            <span>
              {checking
                ? intl.formatMessage(messages.checking)
                : intl.formatMessage(messages.checkToken)}
            </span>
          </Button>
          {shownTokenTrouble && (
            <Alert
              type="error"
              title={intl.formatMessage(
                shownTokenTrouble === 'unreachable'
                  ? messages.unreachable
                  : shownTokenTrouble === 'token'
                    ? messages.tokenRefused
                    : globalMessages.error
              )}
            />
          )}
          {info && !tokenTrouble && (
            <div className="flex items-center gap-3">
              <CachedImage
                type="avatar"
                src={info.bot.avatarUrl}
                alt=""
                width={40}
                height={40}
                className="h-10 w-10 rounded-full"
              />
              <span>
                {intl.formatMessage(messages.botIs, { name: info.bot.name })}
              </span>
            </div>
          )}
          {info?.requiresCodeGrant && (
            <Alert
              type="warning"
              title={intl.formatMessage(messages.codeGrant, { strong })}
            />
          )}
          {info?.isPublic && (
            <Alert
              type="warning"
              title={intl.formatMessage(messages.publicBot, { strong })}
            />
          )}
        </>
      ),
    },
    {
      title: intl.formatMessage(messages.step3Title),
      content: (
        <>
          <p>{intl.formatMessage(messages.step3Text, { strong })}</p>
          <div className="flex flex-wrap gap-3">
            <Button
              as="a"
              buttonType="primary"
              href={info?.inviteUrl}
              target="_blank"
              rel="noreferrer"
              aria-disabled={!info}
              className={info ? undefined : 'pointer-events-none opacity-50'}
            >
              <ArrowTopRightOnSquareIcon />
              <span>{intl.formatMessage(messages.invite)}</span>
            </Button>
            <Button
              buttonType="default"
              disabled={!info}
              onClick={(e) => {
                e.preventDefault();
                mutateGuilds();
              }}
            >
              <ArrowPathIcon />
              <span>{intl.formatMessage(messages.refresh)}</span>
            </Button>
          </div>
          {guilds && (
            <p>
              {guilds.length
                ? intl.formatMessage(messages.inServers, {
                    count: guilds.length,
                  })
                : intl.formatMessage(messages.noServers)}
            </p>
          )}
        </>
      ),
    },
    {
      title: intl.formatMessage(messages.step4Title),
      content: (
        <>
          <p>{intl.formatMessage(messages.step4Text)}</p>
          <div className="form-row">
            <label htmlFor="guildId" className="text-label">
              {intl.formatMessage(messages.server)}
            </label>
            <div className="form-input-area">
              <select
                id="guildId"
                name="guildId"
                value={guildId}
                disabled={!guilds?.length}
                onChange={(e) => {
                  setGuildId(e.target.value);
                  setChannelId('');
                }}
              >
                <option value="">{intl.formatMessage(messages.choose)}</option>
                {guilds?.map((guild) => (
                  <option key={guild.id} value={guild.id}>
                    {guild.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="form-row">
            <label htmlFor="channelId" className="text-label">
              {intl.formatMessage(messages.channel)}
            </label>
            <div className="form-input-area">
              <select
                id="channelId"
                name="channelId"
                value={channelId}
                disabled={!channels?.length}
                onChange={(e) => setChannelId(e.target.value)}
              >
                <option value="">{intl.formatMessage(messages.choose)}</option>
                {channels?.map((channel) => {
                  const name = channel.category
                    ? `${channel.category} / #${channel.name}`
                    : `#${channel.name}`;
                  return (
                    <option key={channel.id} value={channel.id}>
                      {channel.canPost === false
                        ? intl.formatMessage(messages.cantPost, {
                            channel: name,
                          })
                        : name}
                    </option>
                  );
                })}
              </select>
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button
              buttonType="primary"
              disabled={saving || !guildId || !channelId}
              onClick={(e) => {
                e.preventDefault();
                save(
                  { enabled: data?.enabled ?? false },
                  intl.formatMessage(messages.channelSaved)
                );
              }}
            >
              <ArrowDownOnSquareIcon />
              <span>
                {saving
                  ? intl.formatMessage(globalMessages.saving)
                  : intl.formatMessage(messages.saveChannel)}
              </span>
            </Button>
            <Button
              buttonType="default"
              disabled={!guildId}
              onClick={(e) => {
                e.preventDefault();
                mutateChannels();
              }}
            >
              <ArrowPathIcon />
              <span>{intl.formatMessage(messages.refresh)}</span>
            </Button>
          </div>
        </>
      ),
    },
    {
      title: intl.formatMessage(messages.step5Title),
      content: (
        <>
          <p>{intl.formatMessage(messages.step5Text, { strong })}</p>
          <ul className="divide-y divide-gray-700 rounded-md border border-gray-700">
            {approvers?.map((approver) => (
              <li
                key={approver.id}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <span className="flex items-center gap-2">
                  <CachedImage
                    type="avatar"
                    src={approver.avatar}
                    alt=""
                    width={24}
                    height={24}
                    className="h-6 w-6 rounded-full"
                  />
                  <span className="text-strong">{approver.displayName}</span>
                </span>
                <span
                  className={
                    approver.linked && !approver.shared
                      ? 'text-green-400 light:text-green-700'
                      : 'text-yellow-400 light:text-warning-text'
                  }
                >
                  {intl.formatMessage(
                    approver.shared
                      ? messages.shared
                      : approver.linked
                        ? messages.linked
                        : messages.notLinked
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      ),
    },
    {
      title: intl.formatMessage(messages.step6Title),
      content: (
        <>
          <p>{intl.formatMessage(messages.step6Text)}</p>
          <Button
            buttonType="warning"
            // Its buttons only answer in the saved server and channel.
            disabled={
              testing || !info || !channelId || channelId !== savedChannel
            }
            onClick={(e) => {
              e.preventDefault();
              sendTest();
            }}
          >
            <BeakerIcon />
            <span>
              {testing
                ? intl.formatMessage(globalMessages.testing)
                : intl.formatMessage(messages.sendTest)}
            </span>
          </Button>
          {testTrouble && (
            <Alert type="error" title={intl.formatMessage(messages.testFailed)}>
              {intl.formatMessage(
                testTrouble === 'access'
                  ? messages.noAccess
                  : testTrouble === 'permissions'
                    ? messages.noPermission
                    : testTrouble === 'token'
                      ? messages.tokenRefused
                      : testTrouble === 'unreachable'
                        ? messages.unreachable
                        : globalMessages.error
              )}
            </Alert>
          )}
          <div className="form-row">
            <label htmlFor="enabled" className="checkbox-label">
              {intl.formatMessage(messages.enable)}
            </label>
            <div className="form-input-area">
              <input
                type="checkbox"
                id="enabled"
                name="enabled"
                checked={enabled}
                disabled={!ready && !enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              {!ready && (
                <div className="mt-1 text-sm">
                  {intl.formatMessage(messages.needsSetup)}
                </div>
              )}
            </div>
          </div>
          <div className="form-row">
            <label htmlFor="embedPoster" className="checkbox-label">
              {intl.formatMessage(messages.embedPoster)}
            </label>
            <div className="form-input-area">
              <input
                type="checkbox"
                id="embedPoster"
                name="embedPoster"
                checked={embedPoster}
                onChange={(e) => setEmbedPoster(e.target.checked)}
              />
            </div>
          </div>
          <Button
            buttonType="primary"
            disabled={saving || (enabled && !ready)}
            onClick={(e) => {
              e.preventDefault();
              save({ enabled }, intl.formatMessage(messages.saved));
            }}
          >
            <ArrowDownOnSquareIcon />
            <span>
              {saving
                ? intl.formatMessage(globalMessages.saving)
                : intl.formatMessage(globalMessages.save)}
            </span>
          </Button>
        </>
      ),
    },
  ];

  return (
    <div className="section space-y-4">
      <p className="description">{intl.formatMessage(messages.intro)}</p>
      {status && (
        <Alert
          type={
            status.state === 'connected'
              ? 'info'
              : status.state === 'refused' || status.state === 'postFailed'
                ? 'error'
                : 'warning'
          }
          title={
            status.state === 'connected'
              ? intl.formatMessage(messages.statusConnected, {
                  name: status.botName ?? info?.bot.name ?? '',
                })
              : status.state === 'connecting'
                ? intl.formatMessage(messages.statusConnecting)
                : status.state === 'retrying'
                  ? intl.formatMessage(messages.statusRetrying, {
                      detail: status.detail,
                    })
                  : status.state === 'refused'
                    ? status.reason === 'token'
                      ? intl.formatMessage(messages.statusToken)
                      : intl.formatMessage(messages.statusRefused, {
                          detail: status.detail,
                        })
                    : status.state === 'postFailed'
                      ? intl.formatMessage(messages.statusPostFailed, {
                          detail: status.detail,
                        })
                      : intl.formatMessage(messages.statusOff)
          }
        >
          {status.state === 'postFailed' &&
            (status.reason === 'access' || status.reason === 'permissions') &&
            intl.formatMessage(
              status.reason === 'access'
                ? messages.noAccess
                : messages.noPermission
            )}
        </Alert>
      )}
      <ol className="space-y-3">
        {steps.map((step, index) => {
          const number = index + 1;
          const open = current === number;
          return (
            <li
              key={number}
              className="rounded-md border border-gray-700 bg-gray-800/50 light:bg-surface"
            >
              <button
                type="button"
                className="flex w-full items-center gap-3 px-4 py-3 text-left"
                aria-expanded={open}
                onClick={() => setOpenStep(open ? 0 : number)}
              >
                <span
                  className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border-2 text-sm ${
                    done[index]
                      ? 'border-indigo-600 bg-indigo-600 text-on-accent'
                      : open
                        ? 'border-indigo-600 text-strong'
                        : 'border-gray-500 text-gray-400'
                  }`}
                >
                  {done[index] ? <CheckIcon className="h-5 w-5" /> : number}
                </span>
                <span className="font-semibold text-strong">{step.title}</span>
              </button>
              {open && (
                <div className="space-y-4 px-4 pb-4 text-sm leading-6">
                  {step.content}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
};

export default NotificationsDiscordBot;
