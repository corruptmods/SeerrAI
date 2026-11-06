import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { getIntl } from '@server/i18n';
import notificationHttp from '@server/lib/notifications/http';
import requestActionMessages, {
  statusChangeText,
} from '@server/lib/notifications/requestActionMessages';
import { Permission } from '@server/lib/permissions';
import type { RequestAction } from '@server/lib/requestStatusChange';
import { changeRequestStatus } from '@server/lib/requestStatusChange';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { AvailableLocale } from '@server/types/languages';

/*
 * Approve and Decline on Telegram. The buttons are an inline keyboard on the
 * request's message (agents/telegram); presses come back as callback queries,
 * which Seerr AI fetches by long polling the Bot API, so no port has to be
 * open to Telegram. Only while the agent is on, has a bot token and has the
 * buttons turned on.
 */

const API = 'https://api.telegram.org/';

/** How long Telegram holds each poll open waiting for a press. */
const POLL_SECONDS = 30;

/** Telegram's limit for the line shown on a press. */
const ANSWER_LIMIT = 200;
const TEXT_LIMIT = 4096;
const CAPTION_LIMIT = 1024;

interface TelegramUser {
  id: number;
  first_name?: string;
  username?: string;
}

interface TelegramEntity {
  type: string;
  offset: number;
  length: number;
  [key: string]: unknown;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  entities?: TelegramEntity[];
  caption?: string;
  caption_entities?: TelegramEntity[];
}

export interface CallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface Update {
  update_id: number;
  callback_query?: CallbackQuery;
}

/** What a button sends back: at most 64 bytes, so just the action and id. */
export const callbackDataFor = (action: RequestAction, requestId: number) =>
  `sai:${action}:${requestId}`;

const readCallbackData = (data: string | undefined) => {
  const match = /^sai:(approve|decline):([1-9]\d{0,9})$/.exec(data ?? '');
  return match
    ? { action: match[1] as RequestAction, requestId: Number(match[2]) }
    : undefined;
};

/**
 * The Seerr AI account a Telegram user acts as: the one that has them as its
 * Telegram chat (a private chat's id is the user's own id) and may manage
 * requests. Anyone can type any chat id into their own settings, so when more
 * than one such account claims the same person, none of them is used.
 */
export const approverFor = async (
  telegramUserId: number
): Promise<{ user: User } | { reason: 'none' | 'several' }> => {
  const users = await getRepository(User).find({
    where: { settings: { telegramChatId: String(telegramUserId) } },
  });
  const able = users.filter((user) =>
    user.hasPermission(Permission.MANAGE_REQUESTS)
  );
  return able.length === 1
    ? { user: able[0] }
    : { reason: able.length ? 'several' : 'none' };
};

type Trouble = 'conflict' | 'token' | 'other';

/** Telegram's own words for an error; never the address, which has the token. */
const troubleOf = (e: unknown): { kind: Trouble; detail: string } => {
  const error = e as {
    response?: { status?: number; data?: { description?: string } };
    message?: string;
  };
  const status = error.response?.status;
  return {
    kind:
      status === 409
        ? 'conflict'
        : status === 401 || status === 404
          ? 'token'
          : 'other',
    detail:
      error.response?.data?.description ?? error.message ?? 'unknown error',
  };
};

class TelegramButtons {
  /**
   * Waits after a failed poll, doubling from `retryMs` to `longestMs`.
   * Another poller or a webhook (409) and a refused token start at their own,
   * longer, waits: neither clears up by itself in seconds.
   */
  public waits = {
    retryMs: 5_000,
    conflictMs: 60_000,
    tokenMs: 5 * 60_000,
    longestMs: 5 * 60_000,
  };

  private run?: {
    token: string;
    controller: AbortController;
    finished: Promise<void>;
  };

  public get polling(): boolean {
    return !!this.run;
  }

  /**
   * Starts, stops or restarts polling to match the settings as saved. Called
   * at startup and whenever the Telegram settings are saved. A new run starts
   * only once the one before has finished, so two never read at once.
   */
  public refresh(): void {
    const { enabled, options } = getSettings().notifications.agents.telegram;
    const token =
      enabled && options.approvalButtons && options.botAPI
        ? options.botAPI
        : undefined;

    if (this.run?.token === token) {
      return;
    }

    const previous = this.stop();

    if (token) {
      const controller = new AbortController();
      this.run = {
        token,
        controller,
        finished: previous.then(() => this.poll(token, controller.signal)),
      };
      logger.info('Listening for Approve and Decline on Telegram', {
        label: 'Notifications',
      });
    }
  }

  /** Stops polling; resolves once the last poll has ended. */
  public async stop(): Promise<void> {
    const run = this.run;
    if (!run) {
      return;
    }
    this.run = undefined;
    run.controller.abort();
    await run.finished;
    logger.info('Stopped listening for Approve and Decline on Telegram', {
      label: 'Notifications',
    });
  }

  /**
   * One run's polling. Each run starts by dropping what Telegram kept while
   * nobody was reading (up to a day of presses: after a restart, or with the
   * buttons off), asking for the last update only (offset -1, which forgets
   * the rest) and carrying on after it. Presses that old would act late and
   * confusingly, and their answers would fail; a press that was lost can
   * simply be made again, as its buttons are still there.
   */
  private async poll(token: string, signal: AbortSignal): Promise<void> {
    let offset: number | undefined;
    let caughtUp = false;
    let failures = 0;
    let reported: Trouble | undefined;

    while (!signal.aborted) {
      let updates: Update[];
      try {
        const response = await notificationHttp.post<{ result?: Update[] }>(
          `${API}bot${token}/getUpdates`,
          caughtUp
            ? {
                offset,
                timeout: POLL_SECONDS,
                allowed_updates: ['callback_query'],
              }
            : { offset: -1, timeout: 0, allowed_updates: ['callback_query'] },
          { timeout: (POLL_SECONDS + 15) * 1000, signal }
        );
        updates = response.data.result ?? [];
      } catch (e) {
        if (signal.aborted) {
          break;
        }

        const { kind, detail } = troubleOf(e);
        failures += 1;
        // Said once until it clears up, so a lasting problem can't fill the
        // log.
        if (reported !== kind) {
          reported = kind;
          logger.warn(
            kind === 'conflict'
              ? 'Telegram Approve and Decline buttons are waiting: another program is polling this bot, or it has a webhook set. Only one may read its updates.'
              : kind === 'token'
                ? 'Telegram Approve and Decline buttons are waiting: Telegram refused the bot token.'
                : 'Telegram Approve and Decline buttons could not reach Telegram; trying again.',
            { label: 'Notifications', errorMessage: detail }
          );
        } else {
          logger.debug('Telegram button poll failed again', {
            label: 'Notifications',
            errorMessage: detail,
          });
        }

        const first =
          kind === 'conflict'
            ? this.waits.conflictMs
            : kind === 'token'
              ? this.waits.tokenMs
              : this.waits.retryMs;
        await this.wait(
          Math.min(first * 2 ** (failures - 1), this.waits.longestMs),
          signal
        );
        continue;
      }

      if (reported) {
        logger.info('Telegram Approve and Decline buttons are working again', {
          label: 'Notifications',
        });
        reported = undefined;
      }
      failures = 0;

      if (!caughtUp) {
        caughtUp = true;
        const last = updates.at(-1);
        if (last) {
          offset = last.update_id + 1;
          logger.debug('Skipped Telegram button presses from before', {
            label: 'Notifications',
          });
        }
        continue;
      }

      for (const update of updates) {
        // Stopped: leave the rest unacknowledged for whichever run is next,
        // which starts afresh anyway.
        if (signal.aborted) {
          break;
        }
        // Acknowledged by asking from the next id on, even if handling
        // fails: a press that broke something once would break it forever.
        offset = update.update_id + 1;
        if (update.callback_query) {
          await this.handle(token, update.callback_query).catch((e) =>
            logger.error('Could not handle a Telegram button press', {
              label: 'Notifications',
              errorMessage: e instanceof Error ? e.message : String(e),
            })
          );
        }
      }
    }
  }

  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done);
    });
  }

  /**
   * One press. Whoever pressed must be linked to an account that may manage
   * requests; the change is then theirs, as if made in the app. The press is
   * answered with what happened, and the message says so in place of the
   * buttons.
   */
  public async handle(token: string, query: CallbackQuery): Promise<void> {
    const pressed = readCallbackData(query.data);
    if (!pressed) {
      await this.call(token, 'answerCallbackQuery', {
        callback_query_id: query.id,
      });
      return;
    }

    const { applicationTitle } = getSettings().main;
    const approver = await approverFor(query.from.id);

    if ('reason' in approver) {
      logger.info(
        approver.reason === 'several'
          ? 'Telegram button pressed by someone more than one account that manages requests has as its Telegram chat; none of them is used'
          : 'Telegram button pressed by someone who may not approve',
        {
          label: 'Notifications',
          telegramUserId: query.from.id,
          requestId: pressed.requestId,
        }
      );
      await this.call(token, 'answerCallbackQuery', {
        callback_query_id: query.id,
        text: getIntl()
          .formatMessage(
            approver.reason === 'several'
              ? requestActionMessages.severalAccounts
              : requestActionMessages.notLinked,
            { applicationTitle }
          )
          .slice(0, ANSWER_LIMIT),
        show_alert: true,
      });
      return;
    }

    const actor = approver.user;

    const intl = getIntl(actor.settings?.locale as AvailableLocale);
    const change = await changeRequestStatus(
      pressed.requestId,
      pressed.action,
      actor
    );
    const line = statusChangeText(
      change,
      pressed.action,
      actor.displayName,
      intl
    );

    logger.info(`Request ${pressed.action}d from Telegram`, {
      label: 'Notifications',
      requestId: pressed.requestId,
      outcome: change.outcome,
      userId: actor.id,
    });

    await this.call(token, 'answerCallbackQuery', {
      callback_query_id: query.id,
      text: line.slice(0, ANSWER_LIMIT),
    });

    // A blocklisted title can't be approved but can still be declined.
    if (query.message && change.outcome !== 'blocklisted') {
      await this.settle(token, query.message, line);
    }
  }

  /**
   * Adds the outcome to the message, keeping its formatting, and takes the
   * buttons away. A message that would grow too long only loses its buttons.
   */
  private async settle(
    token: string,
    message: TelegramMessage,
    line: string
  ): Promise<void> {
    const target = { chat_id: message.chat.id, message_id: message.message_id };
    const noButtons = { inline_keyboard: [] };
    const withLine = (original: string, entities: TelegramEntity[] = []) => {
      const text = `${original}\n\n${line}`;
      return {
        text,
        // Telegram counts offsets in UTF-16 units, as JavaScript does.
        entities: [
          ...entities,
          {
            type: 'italic',
            offset: text.length - line.length,
            length: line.length,
          },
        ],
      };
    };

    try {
      if (
        message.text !== undefined &&
        message.text.length + line.length + 2 <= TEXT_LIMIT
      ) {
        const { text, entities } = withLine(message.text, message.entities);
        await this.call(token, 'editMessageText', {
          ...target,
          text,
          entities,
          reply_markup: noButtons,
        });
      } else if (
        message.caption !== undefined &&
        message.caption.length + line.length + 2 <= CAPTION_LIMIT
      ) {
        const { text, entities } = withLine(
          message.caption,
          message.caption_entities
        );
        await this.call(token, 'editMessageCaption', {
          ...target,
          caption: text,
          caption_entities: entities,
          reply_markup: noButtons,
        });
      } else {
        await this.call(token, 'editMessageReplyMarkup', {
          ...target,
          reply_markup: noButtons,
        });
      }
    } catch (e) {
      // The press was answered; an old or already edited message is no harm.
      logger.debug('Could not update a Telegram message after a press', {
        label: 'Notifications',
        errorMessage: troubleOf(e).detail,
      });
    }
  }

  private async call(token: string, method: string, body: object) {
    await notificationHttp.post(`${API}bot${token}/${method}`, body);
  }
}

const telegramButtons = new TelegramButtons();

export default telegramButtons;
