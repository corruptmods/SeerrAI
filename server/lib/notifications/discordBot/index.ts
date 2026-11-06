import { EmbedColors } from '@server/constants/discord';
import {
  DECLINE_REASON_MAX_LENGTH,
  MediaRequestStatus,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import DiscordApprovalMessage from '@server/entity/DiscordApprovalMessage';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { getIntl } from '@server/i18n';
import globalMessages from '@server/i18n/globalMessages';
import type { DiscordBotTroubleReason } from '@server/interfaces/api/discordBotInterfaces';
import { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import type { DiscordRichEmbed } from '@server/lib/notifications/agents/discord';
import DiscordAgent from '@server/lib/notifications/agents/discord';
import type {
  GatewaySocketConstructor,
  GatewayWaits,
  IdentifyClock,
  RefusedReason,
} from '@server/lib/notifications/discordBot/gateway';
import {
  DEFAULT_GATEWAY_WAITS,
  Gateway,
} from '@server/lib/notifications/discordBot/gateway';
import discordBotMessages from '@server/lib/notifications/discordBot/messages';
import {
  INTERACTION_RETRY_MS,
  discordRequest,
  discordTrouble,
} from '@server/lib/notifications/discordBot/rest';
import requestActionMessages, {
  statusChangeText,
} from '@server/lib/notifications/requestActionMessages';
import { Permission } from '@server/lib/permissions';
import type {
  RequestAction,
  StatusChange,
} from '@server/lib/requestStatusChange';
import {
  REQUEST_ACTIONS,
  changeRequestStatus,
} from '@server/lib/requestStatusChange';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { In, LessThan, Not } from 'typeorm';

/*
 * Seerr AI's own Discord bot, for approving and declining from Discord. It
 * posts each request waiting for approval to the chosen channel with Approve
 * and Decline buttons; presses arrive over the Gateway (./gateway), which
 * Seerr AI connects out to, so no port has to be open and there is no
 * interactions endpoint for anyone to call. Only while it's turned on and set
 * up; separate from the webhook agent (agents/discord).
 */

/** Interaction types and responses used (Discord API v10). */
const InteractionType = { MESSAGE_COMPONENT: 3, MODAL_SUBMIT: 5 } as const;
const Reply = {
  CHANNEL_MESSAGE: 4,
  DEFERRED_UPDATE_MESSAGE: 6,
  MODAL: 9,
} as const;
const EPHEMERAL = 64;

/** Discord's limits for a modal's title and a text input's label. */
const MODAL_TEXT_LIMIT = 45;
const CONTENT_LIMIT = 2000;

const DAY = 24 * 60 * 60 * 1000;

/** Request ids are int4. */
const LARGEST_ID = 2_147_483_647;

interface DiscordUserLite {
  id: string;
  username?: string;
}

interface ModalComponent {
  type: number;
  custom_id?: string;
  value?: string;
  components?: ModalComponent[];
  component?: ModalComponent;
}

export interface Interaction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  guild_id?: string;
  data?: { custom_id?: string; components?: ModalComponent[] };
  member?: { user?: DiscordUserLite };
  user?: DiscordUserLite;
  message?: { id: string; channel_id: string; embeds?: DiscordRichEmbed[] };
}

export type DiscordBotStatus =
  | { state: 'off' }
  | { state: 'connecting' }
  | { state: 'connected'; botName?: string }
  | { state: 'retrying'; detail: string }
  | { state: 'refused'; reason: RefusedReason; detail: string }
  /** Connected, but the last request couldn't be posted to the channel. */
  | {
      state: 'postFailed';
      botName?: string;
      reason: DiscordBotTroubleReason;
      detail: string;
    };

type Pressed =
  | { kind: 'test' }
  | { kind: 'request'; action: RequestAction; requestId: number };

/**
 * What a button or the decline form sends back: the action and the request,
 * nothing secret. Who pressed comes from Discord itself.
 */
export const customIdFor = (action: RequestAction, requestId: number) =>
  `sai:${action}:${requestId}`;
const reasonFormId = (requestId: number) => `sai:reason:${requestId}`;
const testId = (action: RequestAction) => `sai:test:${action}`;

const requestIdOf = (text: string): number | undefined => {
  const id = Number(text);
  return id <= LARGEST_ID ? id : undefined;
};

const readCustomId = (interaction: Interaction): Pressed | undefined => {
  const id = interaction.data?.custom_id ?? '';
  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    if (/^sai:test:(approve|decline)$/.test(id)) {
      return { kind: 'test' };
    }
    const match = /^sai:(approve|decline):([1-9]\d{0,9})$/.exec(id);
    const requestId = match && requestIdOf(match[2]);
    return requestId
      ? { kind: 'request', action: match[1] as RequestAction, requestId }
      : undefined;
  }
  if (interaction.type === InteractionType.MODAL_SUBMIT) {
    const match = /^sai:reason:([1-9]\d{0,9})$/.exec(id);
    const requestId = match && requestIdOf(match[1]);
    return requestId
      ? { kind: 'request', action: 'decline', requestId }
      : undefined;
  }
};

/** The reason typed into the decline form; none when left blank. */
const reasonOf = (components: ModalComponent[] = []): string | null => {
  for (const component of components) {
    if (
      component.custom_id === 'reason' &&
      typeof component.value === 'string'
    ) {
      const reason = component.value.trim().slice(0, DECLINE_REASON_MAX_LENGTH);
      return reason || null;
    }
    const inner = reasonOf([
      ...(component.components ?? []),
      ...(component.component ? [component.component] : []),
    ]);
    if (inner !== null) {
      return inner;
    }
  }
  return null;
};

/**
 * The Seerr AI account a Discord user acts as: the one with their Discord
 * user ID that may manage requests. Anyone can type any ID into their own
 * settings, so when more than one such account has the same one, none of
 * them is used.
 */
export const discordApproverFor = async (
  discordUserId: string
): Promise<{ user: User } | { reason: 'none' | 'several' }> => {
  const users = await getRepository(User).find();
  const able = users.filter(
    (user) =>
      user.settings?.discordIds?.includes(discordUserId) &&
      user.hasPermission(Permission.MANAGE_REQUESTS)
  );
  return able.length === 1
    ? { user: able[0] }
    : { reason: able.length ? 'several' : 'none' };
};

const buttonsRow = (customId: (action: RequestAction) => string) => {
  const intl = getIntl();
  return {
    type: 1,
    components: REQUEST_ACTIONS.map((action) => ({
      type: 2,
      // Green and red.
      style: action === 'approve' ? 3 : 4,
      label: intl.formatMessage(requestActionMessages[action]),
      custom_id: customId(action),
    })),
  };
};

/** Only what can be sent back: Discord adds sizes and proxy addresses. */
const sendable = (embed: DiscordRichEmbed): DiscordRichEmbed => ({
  title: embed.title,
  description: embed.description,
  url: embed.url,
  timestamp: embed.timestamp,
  color: embed.color,
  footer: embed.footer && {
    text: embed.footer.text,
    icon_url: embed.footer.icon_url,
  },
  image: embed.image?.url ? { url: embed.image.url } : undefined,
  thumbnail: embed.thumbnail?.url ? { url: embed.thumbnail.url } : undefined,
  author: embed.author && {
    name: embed.author.name,
    url: embed.author.url,
    icon_url: embed.author.icon_url,
  },
  fields: embed.fields,
});

/**
 * The message's embeds with what happened as its request status, in place of
 * "Pending Approval". The message is in the server's language, so the field
 * is found by that language's name for it.
 */
export const settledEmbeds = (
  embeds: DiscordRichEmbed[] | undefined,
  line: string,
  color: number
): DiscordRichEmbed[] => {
  const name = getIntl().formatMessage(globalMessages.requestStatus);
  return (embeds ?? []).map((embed, index) => {
    if (index) {
      return sendable(embed);
    }
    const fields = [...(embed.fields ?? [])];
    const status = { name, value: line, inline: true };
    const at = fields.findIndex((field) => field.name === name);
    if (at >= 0) {
      fields[at] = status;
    } else {
      fields.push(status);
    }
    return { ...sendable(embed), fields, color };
  });
};

const colorOf = (status: MediaRequestStatus | undefined) =>
  status === MediaRequestStatus.DECLINED
    ? EmbedColors.RED
    : status === undefined
      ? EmbedColors.GREY
      : EmbedColors.PURPLE;

const changeColor = (change: StatusChange) =>
  colorOf('request' in change ? change.request.status : undefined);

/** What a request that's no longer pending became, as a decision. */
const decisionOf = (request: MediaRequest): RequestAction =>
  request.status === MediaRequestStatus.DECLINED ? 'decline' : 'approve';

/**
 * The line a settled request's message shows: "Approved by X", from whoever
 * changed it, or just "Already approved" when that isn't known.
 */
const settledLine = (request: MediaRequest) => {
  const name = request.modifiedBy?.displayName;
  return statusChangeText(
    name ? { outcome: 'done', request } : { outcome: 'notPending', request },
    decisionOf(request),
    name ?? '',
    getIntl()
  );
};

/** For a second press: "Already approved by X". */
const alreadyLine = (request: MediaRequest) => {
  const name = request.modifiedBy?.displayName;
  const intl = getIntl();
  const declined = request.status === MediaRequestStatus.DECLINED;
  return name
    ? intl.formatMessage(
        declined
          ? discordBotMessages.alreadyDeclinedBy
          : discordBotMessages.alreadyApprovedBy,
        { userName: name }
      )
    : intl.formatMessage(
        declined
          ? requestActionMessages.alreadyDeclined
          : requestActionMessages.alreadyApproved
      );
};

class DiscordBot {
  /** @internal Waits between connections (see Gateway); shortened in tests. */
  public waits: GatewayWaits = { ...DEFAULT_GATEWAY_WAITS };
  /** @internal Node's WebSocket; replaced in tests. */
  public Socket: GatewaySocketConstructor =
    globalThis.WebSocket as unknown as GatewaySocketConstructor;
  /** @internal Heartbeat jitter; replaced in tests. */
  public random: () => number = Math.random;

  private _status: DiscordBotStatus = { state: 'off' };
  /** Kept across runs, so Identifies stay apart even after a restart. */
  private identified: IdentifyClock = { lastAt: 0 };
  /** Why the last request couldn't be posted; cleared by the next post. */
  private postError?: { reason: DiscordBotTroubleReason; detail: string };
  private botName?: string;
  /** Said once until it clears up, so a lasting problem can't fill the log. */
  private reported = false;
  /** Requests a press is being handled for, which edits its own message. */
  private pressing = new Set<number>();

  private run?: {
    token: string;
    controller: AbortController;
    finished: Promise<void>;
  };

  public get status(): DiscordBotStatus {
    return this._status.state === 'connected' && this.postError
      ? {
          state: 'postFailed',
          botName: this._status.botName,
          ...this.postError,
        }
      : this._status;
  }

  /**
   * Connects, disconnects or reconnects to match the settings as saved.
   * Called at startup and whenever the bot's settings are saved. A new
   * connection starts only once the one before has closed, so two never run
   * at once. Saving again also retries after Discord refused the bot.
   */
  public refresh(): void {
    const { enabled, options } = getSettings().notifications.agents.discordBot;
    const token =
      enabled && options.botToken && options.channelId
        ? options.botToken
        : undefined;

    if (this.run?.token === token && this._status.state !== 'refused') {
      return;
    }

    const previous = this.stop();

    if (token) {
      const controller = new AbortController();
      this._status = { state: 'connecting' };
      this.run = {
        token,
        controller,
        // Never rejects, so the next run can always follow this one.
        finished: previous
          .then(() => this.listen(token, controller.signal))
          .catch((e) => {
            logger.error('The Discord bot stopped unexpectedly', {
              label: 'Notifications',
              errorMessage: e instanceof Error ? e.message : String(e),
            });
          }),
      };
      logger.info('Connecting the Discord bot', { label: 'Notifications' });
    }
  }

  /** Disconnects; resolves once the connection has closed. */
  public async stop(): Promise<void> {
    const run = this.run;
    this._status = { state: 'off' };
    if (!run) {
      return;
    }
    this.run = undefined;
    run.controller.abort();
    await run.finished;
    logger.info('Disconnected the Discord bot', { label: 'Notifications' });
  }

  private async listen(token: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return;
    }
    this.reported = false;
    const gateway = new Gateway(
      token,
      {
        onReady: (user) => {
          if (signal.aborted) {
            return;
          }
          if (user) {
            this.botName = user.global_name || user.username;
          }
          this._status = { state: 'connected', botName: this.botName };
          if (this.reported) {
            this.reported = false;
            logger.info('The Discord bot is connected again', {
              label: 'Notifications',
            });
          } else {
            logger.info('The Discord bot is connected', {
              label: 'Notifications',
              bot: this.botName,
            });
          }
        },
        onDispatch: (event, data) => {
          if (event === 'INTERACTION_CREATE' && !signal.aborted) {
            this.handle(token, data as Interaction).catch((e) =>
              logger.error('Could not handle a Discord button press', {
                label: 'Notifications',
                errorMessage: e instanceof Error ? e.message : String(e),
              })
            );
          }
        },
        onTrouble: (detail) => {
          if (signal.aborted) {
            return;
          }
          this._status = { state: 'retrying', detail };
          if (!this.reported) {
            this.reported = true;
            logger.warn('The Discord bot lost its connection; trying again', {
              label: 'Notifications',
              errorMessage: detail,
            });
          } else {
            logger.debug('The Discord bot could not connect again', {
              label: 'Notifications',
              errorMessage: detail,
            });
          }
        },
      },
      this.Socket,
      this.waits,
      this.random,
      this.identified
    );

    const end = await gateway.run(signal);
    if (end.kind === 'refused' && !signal.aborted) {
      this._status = {
        state: 'refused',
        reason: end.reason,
        detail: end.detail,
      };
      logger.error(
        end.reason === 'token'
          ? 'Discord refused the Discord bot’s token, so it stopped. Paste a new one in Settings → Notifications → Discord Bot.'
          : 'Discord refused the Discord bot’s connection, so it stopped.',
        { label: 'Notifications', errorMessage: end.detail }
      );
    }
  }

  /**
   * One press of a button, or the decline form sent. Only presses on the
   * bot's own messages in its chosen server count, and whoever pressed must
   * be linked to an account that may manage requests; the change is then
   * theirs, as if made in the app. Every interaction is answered within
   * Discord's three seconds: refusals straight away, privately; a change is
   * acknowledged first and the message edited once it's done.
   */
  public async handle(token: string, interaction: Interaction): Promise<void> {
    // A late answer always fails, so a long wait on a 429 is no use.
    const reply = (body: object) =>
      discordRequest(
        token,
        'POST',
        `/interactions/${interaction.id}/${interaction.token}/callback`,
        body,
        undefined,
        INTERACTION_RETRY_MS
      );
    const privately = (content: string) =>
      reply({
        type: Reply.CHANNEL_MESSAGE,
        data: { content: content.slice(0, CONTENT_LIMIT), flags: EPHEMERAL },
      });

    const pressed = readCustomId(interaction);
    if (!pressed) {
      // Not one of ours; acknowledged so Discord doesn't show an error.
      if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
        await reply({ type: Reply.DEFERRED_UPDATE_MESSAGE });
      }
      return;
    }

    const intl = getIntl();
    const { applicationTitle } = getSettings().main;
    const { guildId } = getSettings().notifications.agents.discordBot.options;
    const presserId = interaction.member?.user?.id ?? interaction.user?.id;
    const notHere = () =>
      privately(
        intl.formatMessage(discordBotMessages.notHere, { applicationTitle })
      );

    // Only in the chosen server, and for requests only on a message the bot
    // posted there for that request.
    if (
      !interaction.guild_id ||
      interaction.guild_id !== guildId ||
      (pressed.kind === 'request' &&
        !(await this.isOwnMessage(interaction, pressed.requestId)))
    ) {
      logger.info('Discord button pressed outside the bot’s own messages', {
        label: 'Notifications',
        discordUserId: presserId,
        guildId: interaction.guild_id,
      });
      await notHere();
      return;
    }

    const approver = presserId
      ? await discordApproverFor(presserId)
      : { reason: 'none' as const };
    const refusal = (reason: 'none' | 'several') =>
      intl.formatMessage(
        reason === 'several'
          ? discordBotMessages.severalAccounts
          : discordBotMessages.notLinked,
        { applicationTitle }
      );

    if (pressed.kind === 'test') {
      await privately(
        `${intl.formatMessage(discordBotMessages.testPressed)} ${
          'user' in approver
            ? intl.formatMessage(discordBotMessages.testLinked, {
                userName: approver.user.displayName,
                applicationTitle,
              })
            : refusal(approver.reason)
        }`
      );
      return;
    }

    if ('reason' in approver) {
      logger.info(
        approver.reason === 'several'
          ? 'Discord button pressed by someone more than one account that manages requests has as a Discord user ID; none of them is used'
          : 'Discord button pressed by someone who may not approve',
        {
          label: 'Notifications',
          discordUserId: presserId,
          requestId: pressed.requestId,
        }
      );
      await privately(refusal(approver.reason));
      return;
    }

    const actor = approver.user;
    const { action, requestId } = pressed;

    // Decline asks for an optional reason first, as in the app. A request
    // that's no longer pending is settled straight away instead.
    if (
      interaction.type === InteractionType.MESSAGE_COMPONENT &&
      action === 'decline'
    ) {
      const request = await getRepository(MediaRequest).findOne({
        where: { id: requestId },
      });
      if (request?.status === MediaRequestStatus.PENDING) {
        await reply({
          type: Reply.MODAL,
          data: {
            custom_id: reasonFormId(requestId),
            title: intl
              .formatMessage(discordBotMessages.declineTitle)
              .slice(0, MODAL_TEXT_LIMIT),
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 4,
                    custom_id: 'reason',
                    // Paragraph.
                    style: 2,
                    label: intl
                      .formatMessage(discordBotMessages.declineReason)
                      .slice(0, MODAL_TEXT_LIMIT),
                    required: false,
                    max_length: DECLINE_REASON_MAX_LENGTH,
                  },
                ],
              },
            ],
          },
        });
        return;
      }
    }

    const declineReason =
      interaction.type === InteractionType.MODAL_SUBMIT
        ? reasonOf(interaction.data?.components)
        : undefined;

    // Approving can take a while (the save hooks send it on), longer than
    // Discord waits for an answer.
    await reply({ type: Reply.DEFERRED_UPDATE_MESSAGE });

    const followUp = (content: string) =>
      discordRequest(
        token,
        'POST',
        `/webhooks/${interaction.application_id}/${interaction.token}`,
        { content: content.slice(0, CONTENT_LIMIT), flags: EPHEMERAL }
      );
    const pressedId = interaction.message?.id;

    this.pressing.add(requestId);
    try {
      const change = await changeRequestStatus(requestId, action, actor, {
        declineReason,
      });

      logger.info(`Request ${action}d from Discord`, {
        label: 'Notifications',
        requestId,
        outcome: change.outcome,
        userId: actor.id,
      });

      // A blocklisted title can't be approved but can still be declined, so
      // the buttons stay.
      if (change.outcome === 'blocklisted') {
        await followUp(
          statusChangeText(change, action, actor.displayName, intl)
        );
        return;
      }

      // Whoever decided first is who the message names, even when this
      // press came second.
      const line =
        change.outcome === 'notFound'
          ? statusChangeText(change, action, actor.displayName, intl)
          : settledLine(change.request);

      if (pressedId) {
        await getRepository(DiscordApprovalMessage).delete({
          requestId,
          messageId: pressedId,
        });
      }
      let edited = true;
      try {
        await discordRequest(
          token,
          'PATCH',
          `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
          {
            embeds: settledEmbeds(
              interaction.message?.embeds,
              line,
              changeColor(change)
            ),
            components: [],
          }
        );
      } catch (e) {
        edited = false;
        logger.debug('Could not update a Discord message after a press', {
          label: 'Notifications',
          errorMessage: e instanceof Error ? e.message : String(e),
        });
      }

      if (change.outcome === 'notPending') {
        await followUp(alreadyLine(change.request));
      } else if (!edited) {
        // The change is made; say so privately instead.
        await followUp(line);
      }

      // Other messages for the same request (posted again, or to another
      // channel) lose their buttons too.
      if (change.outcome !== 'notFound') {
        await this.settleMessages(token, change.request, pressedId);
      }
    } catch (e) {
      logger.error('Could not approve or decline a request from Discord', {
        label: 'Notifications',
        requestId,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      await followUp(
        intl.formatMessage(requestActionMessages.failed, { applicationTitle })
      ).catch(() => undefined);
    } finally {
      this.pressing.delete(requestId);
    }
  }

  /**
   * Whether a press came from a message the bot posted for this request: one
   * it keeps, or, once that's been let go, one in its chosen channel.
   */
  private async isOwnMessage(
    interaction: Interaction,
    requestId: number
  ): Promise<boolean> {
    const message = interaction.message;
    if (!message) {
      return false;
    }
    const kept = await getRepository(DiscordApprovalMessage).findOne({
      where: { messageId: message.id },
    });
    return kept
      ? kept.requestId === requestId && kept.channelId === message.channel_id
      : message.channel_id ===
          getSettings().notifications.agents.discordBot.options.channelId;
  }

  /**
   * Posts a request waiting for approval, with the buttons, and keeps where
   * it went so the buttons can be taken away later. A failure shows in the
   * status until a post works again.
   */
  public async postPending(payload: NotificationPayload): Promise<void> {
    const settings = getSettings().notifications.agents.discordBot;
    const { botToken, channelId } = settings.options;
    const requestId = payload.request!.id;

    let message: { id: string; channel_id?: string };
    try {
      message = await discordRequest(
        botToken,
        'POST',
        `/channels/${channelId}/messages`,
        {
          embeds: [
            new DiscordAgent().buildEmbed(
              Notification.MEDIA_PENDING,
              payload,
              undefined,
              settings.embedPoster
            ),
          ],
          components: [buttonsRow((action) => customIdFor(action, requestId))],
          allowed_mentions: { parse: [] },
        }
      );
    } catch (e) {
      this.postError = {
        reason: discordTrouble(e),
        detail: e instanceof Error ? e.message : String(e),
      };
      throw e;
    }
    this.postError = undefined;

    await getRepository(DiscordApprovalMessage).save(
      new DiscordApprovalMessage({
        requestId,
        channelId: message.channel_id ?? channelId,
        messageId: message.id,
      })
    );
  }

  /**
   * A request approved or declined somewhere else (the app, ntfy, Telegram):
   * its messages say so and lose their buttons, so none are left that only
   * say "Already approved".
   */
  public async settle(request: MediaRequest): Promise<void> {
    if (
      request.status === MediaRequestStatus.PENDING ||
      this.pressing.has(request.id)
    ) {
      return;
    }
    await this.settleMessages(
      getSettings().notifications.agents.discordBot.options.botToken,
      request
    );
  }

  /** Lets go of a settled request's messages, and edits them to say so. */
  private async settleMessages(
    token: string,
    request: MediaRequest,
    exceptMessageId?: string
  ): Promise<void> {
    const repository = getRepository(DiscordApprovalMessage);
    const messages = await repository.find({
      where: {
        requestId: request.id,
        ...(exceptMessageId ? { messageId: Not(exceptMessageId) } : {}),
      },
    });
    if (!messages.length) {
      return;
    }
    await repository.delete(messages.map((message) => message.id));

    const line = settledLine(request);
    for (const { channelId, messageId } of messages) {
      const path = `/channels/${channelId}/messages/${messageId}`;
      try {
        const message = await discordRequest<{ embeds?: DiscordRichEmbed[] }>(
          token,
          'GET',
          path
        );
        await discordRequest(token, 'PATCH', path, {
          embeds: settledEmbeds(message.embeds, line, colorOf(request.status)),
          components: [],
        });
      } catch (e) {
        // A deleted message, or a channel the bot can no longer see.
        logger.debug('Could not update a Discord message after a change', {
          label: 'Notifications',
          requestId: request.id,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  /**
   * For the nightly database maintenance: messages of requests settled more
   * than a day ago that are still kept (settled while the bot was off, say).
   * With the bot on, they're edited first; either way they're let go.
   * Returns how many were let go.
   */
  public async prune(now = Date.now()): Promise<number> {
    const repository = getRepository(DiscordApprovalMessage);
    const stale = await repository.find({
      where: {
        createdAt: LessThan(new Date(now - DAY)),
        request: { status: Not(MediaRequestStatus.PENDING) },
      },
      relations: { request: { modifiedBy: true } },
    });
    if (!stale.length) {
      return 0;
    }

    const { enabled, options } = getSettings().notifications.agents.discordBot;
    if (enabled && options.botToken) {
      const requests = new Map(
        stale.map((row) => [row.requestId, row.request])
      );
      for (const request of requests.values()) {
        await this.settleMessages(options.botToken, request).catch((e) =>
          logger.debug('Could not settle old Discord messages', {
            label: 'Notifications',
            requestId: request.id,
            errorMessage: e instanceof Error ? e.message : String(e),
          })
        );
      }
    }
    await repository.delete({ id: In(stale.map((row) => row.id)) });
    return stale.length;
  }

  /** Lets go of every kept message, as a new bot can't edit the old one's. */
  public async forgetMessages(): Promise<void> {
    await getRepository(DiscordApprovalMessage).clear();
  }

  /** The setup page's test: a message whose buttons only say it's a test. */
  public async sendTest(token: string, channelId: string): Promise<string> {
    const intl = getIntl();
    const { applicationTitle } = getSettings().main;
    const message = await discordRequest<{ id: string }>(
      token,
      'POST',
      `/channels/${channelId}/messages`,
      {
        embeds: [
          {
            title: intl.formatMessage(discordBotMessages.testTitle, {
              applicationTitle,
            }),
            description: intl.formatMessage(discordBotMessages.testMessage),
            color: EmbedColors.ORANGE,
            timestamp: new Date().toISOString(),
          },
        ],
        components: [buttonsRow(testId)],
        allowed_mentions: { parse: [] },
      }
    );
    // Posting to the bot's channel works again.
    if (
      channelId ===
      getSettings().notifications.agents.discordBot.options.channelId
    ) {
      this.postError = undefined;
    }
    return message.id;
  }
}

const discordBot = new DiscordBot();

export default discordBot;
