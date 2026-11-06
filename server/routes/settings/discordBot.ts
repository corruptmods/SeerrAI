import { DISCORD_SNOWFLAKE_REGEX } from '@server/constants/discord';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import type {
  DiscordBotApprover,
  DiscordBotChannel,
  DiscordBotGuild,
  DiscordBotInfoResponse,
  DiscordBotSettingsResponse,
  DiscordBotTroubleReason,
} from '@server/interfaces/api/discordBotInterfaces';
import discordBot from '@server/lib/notifications/discordBot';
import {
  discordRequest,
  discordTrouble,
} from '@server/lib/notifications/discordBot/rest';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';

/*
 * Settings → Notifications → Discord Bot and its setup steps: check the
 * token, invite the bot, pick a channel, see who can approve, send a test.
 * Admins only (the settings routes need Admin). The token is never sent
 * back: the page only learns whether one is saved.
 */
const discordBotRoutes = Router();

/**
 * What the bot needs in its channel: View Channel, Send Messages, Embed
 * Links, and Read Message History to fetch a message again to take its
 * buttons away.
 */
export const BotPermission = {
  ADMINISTRATOR: BigInt(1) << BigInt(3),
  VIEW_CHANNEL: BigInt(1) << BigInt(10),
  SEND_MESSAGES: BigInt(1) << BigInt(11),
  EMBED_LINKS: BigInt(1) << BigInt(14),
  READ_MESSAGE_HISTORY: BigInt(1) << BigInt(16),
};
export const NEEDED_PERMISSIONS =
  BotPermission.VIEW_CHANNEL |
  BotPermission.SEND_MESSAGES |
  BotPermission.EMBED_LINKS |
  BotPermission.READ_MESSAGE_HISTORY;

/** Text and announcement channels: the ones a bot can post to. */
const POSTABLE_CHANNEL_TYPES = new Set([0, 5]);
const CATEGORY = 4;

export const inviteUrlFor = (applicationId: string): string =>
  `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot&permissions=${NEEDED_PERMISSIONS}`;

const snowflake = z.string().regex(DISCORD_SNOWFLAKE_REGEX);

const settingsBody = z.object({
  enabled: z.boolean(),
  embedPoster: z.boolean(),
  options: z.object({
    guildId: snowflake.or(z.literal('')),
    channelId: snowflake.or(z.literal('')),
  }),
});

const tokenBody = z.object({
  // Pasted with "Bot " in front, or with spaces around, it's the same token.
  botToken: z
    .string()
    .trim()
    .transform((token) => token.replace(/^Bot\s+/i, ''))
    .pipe(z.string().regex(/^[\w.-]{30,200}$/)),
});

const testBody = z.object({ channelId: snowflake });

type Trouble = DiscordBotTroubleReason;

/** Discord's answer, for the page to explain; never the token. */
const troubleOf = (e: unknown): { reason: Trouble; detail: string } => ({
  reason: discordTrouble(e),
  detail: e instanceof Error ? e.message : String(e),
});

const MESSAGES: Record<Trouble, string> = {
  token: 'Discord refused the bot token.',
  unreachable: 'Could not reach Discord.',
  access: 'The bot can’t see that channel.',
  permissions: 'The bot may not post there.',
  other: 'Discord refused the request.',
};

const failed = (res: Response, e: unknown, what: string) => {
  const { reason, detail } = troubleOf(e);
  logger.warn(`Discord bot setup: ${what}`, {
    label: 'API',
    errorMessage: detail,
  });
  return res
    .status(reason === 'unreachable' ? 502 : 400)
    .json({ message: MESSAGES[reason], reason, detail });
};

const shown = (): DiscordBotSettingsResponse => {
  const bot = getSettings().notifications.agents.discordBot;
  return {
    enabled: bot.enabled,
    embedPoster: bot.embedPoster,
    options: {
      botToken: '',
      applicationId: bot.options.applicationId,
      guildId: bot.options.guildId,
      channelId: bot.options.channelId,
    },
    hasBotToken: !!bot.options.botToken,
    status: discordBot.status,
  };
};

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
}

const avatarOf = (user: DiscordUser) =>
  user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
    : `https://cdn.discordapp.com/embed/avatars/${Number(
        (BigInt(user.id) >> BigInt(22)) % BigInt(6)
      )}.png`;

/** Who the token is, and what's needed to invite it. */
const botInfo = async (token: string): Promise<DiscordBotInfoResponse> => {
  const [user, application] = await Promise.all([
    discordRequest<DiscordUser>(token, 'GET', '/users/@me'),
    discordRequest<{
      id: string;
      name: string;
      bot_public?: boolean;
      bot_require_code_grant?: boolean;
    }>(token, 'GET', '/applications/@me'),
  ]);
  return {
    bot: {
      id: user.id,
      name: user.global_name || user.username,
      avatarUrl: avatarOf(user),
    },
    applicationId: application.id,
    applicationName: application.name,
    inviteUrl: inviteUrlFor(application.id),
    // Discord won't add a bot that needs a code grant from a plain invite.
    requiresCodeGrant: !!application.bot_require_code_grant,
    // Anyone could add a public bot to their own server.
    isPublic: !!application.bot_public,
  };
};

const savedToken = () =>
  getSettings().notifications.agents.discordBot.options.botToken;

const noToken = (res: Response) =>
  res.status(400).json({
    message: 'Add the bot token first.',
    reason: 'token',
  });

discordBotRoutes.get('/', (_req, res) => {
  res.status(200).json(shown());
});

discordBotRoutes.post('/', async (req, res) => {
  const parsed = settingsBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Check the Discord bot settings.' });
  }
  const { enabled, embedPoster, options } = parsed.data;
  if (enabled && (!savedToken() || !options.guildId || !options.channelId)) {
    return res.status(400).json({
      message: 'Add the bot token and pick a channel before turning it on.',
    });
  }

  const settings = getSettings();
  const bot = settings.notifications.agents.discordBot;
  bot.enabled = enabled;
  bot.embedPoster = embedPoster;
  bot.options.guildId = options.guildId;
  bot.options.channelId = options.channelId;
  await settings.save();
  discordBot.refresh();

  return res.status(200).json(shown());
});

discordBotRoutes.get('/bot', async (_req, res) => {
  const token = savedToken();
  if (!token) {
    return noToken(res);
  }
  try {
    return res.status(200).json(await botInfo(token));
  } catch (e) {
    return failed(res, e, 'the saved token was refused');
  }
});

/** Checks a token and keeps it once Discord accepts it. */
discordBotRoutes.put('/token', async (req, res) => {
  const parsed = tokenBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      message: 'That doesn’t look like a bot token.',
      reason: 'token',
    });
  }
  const token = parsed.data.botToken;

  let info: DiscordBotInfoResponse;
  try {
    info = await botInfo(token);
  } catch (e) {
    return failed(res, e, 'a new token was refused');
  }

  const settings = getSettings();
  const bot = settings.notifications.agents.discordBot;
  // Another application's bot isn't in the chosen server, so start the
  // later steps again.
  // Its messages can't be edited by the new bot either.
  if (bot.options.applicationId !== info.applicationId) {
    bot.options.guildId = '';
    bot.options.channelId = '';
    bot.enabled = false;
    await discordBot.forgetMessages();
  }
  bot.options.botToken = token;
  bot.options.applicationId = info.applicationId;
  await settings.save();
  discordBot.refresh();

  return res.status(200).json(info);
});

discordBotRoutes.get('/guilds', async (_req, res) => {
  const token = savedToken();
  if (!token) {
    return noToken(res);
  }
  try {
    const guilds = await discordRequest<
      { id: string; name: string; icon?: string | null }[]
    >(token, 'GET', '/users/@me/guilds');
    return res.status(200).json(
      guilds.map(
        (guild): DiscordBotGuild => ({
          id: guild.id,
          name: guild.name,
          iconUrl: guild.icon
            ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=64`
            : null,
        })
      )
    );
  } catch (e) {
    return failed(res, e, 'could not list servers');
  }
});

interface Overwrite {
  id: string;
  /** 0 a role, 1 a member. */
  type: number;
  allow: string;
  deny: string;
}

interface Channel {
  id: string;
  name: string;
  type: number;
  position?: number;
  parent_id?: string | null;
  permission_overwrites?: Overwrite[];
}

/**
 * The bot's permissions in a channel, the way Discord works them out: the
 * server's @everyone and the bot's roles, then the channel's overwrites for
 * @everyone, the roles and the bot itself, in that order.
 */
export const channelPermissions = (
  guild: {
    id: string;
    owner_id: string;
    roles: { id: string; permissions: string }[];
  },
  member: { roles: string[] },
  botId: string,
  channel: Channel
): bigint => {
  const all = ~BigInt(0);
  if (guild.owner_id === botId) {
    return all;
  }
  const roleBits = new Map(
    guild.roles.map((role) => [role.id, BigInt(role.permissions)])
  );
  let permissions = roleBits.get(guild.id) ?? BigInt(0);
  for (const role of member.roles) {
    permissions |= roleBits.get(role) ?? BigInt(0);
  }
  if (permissions & BotPermission.ADMINISTRATOR) {
    return all;
  }

  const overwrites = channel.permission_overwrites ?? [];
  const apply = (allow: bigint, deny: bigint) => {
    permissions = (permissions & ~deny) | allow;
  };
  const everyone = overwrites.find((o) => o.type === 0 && o.id === guild.id);
  if (everyone) {
    apply(BigInt(everyone.allow), BigInt(everyone.deny));
  }
  let allow = BigInt(0);
  let deny = BigInt(0);
  for (const o of overwrites) {
    if (o.type === 0 && member.roles.includes(o.id)) {
      allow |= BigInt(o.allow);
      deny |= BigInt(o.deny);
    }
  }
  apply(allow, deny);
  const own = overwrites.find((o) => o.type === 1 && o.id === botId);
  if (own) {
    apply(BigInt(own.allow), BigInt(own.deny));
  }
  return permissions;
};

discordBotRoutes.get<{ guildId: string }>(
  '/guilds/:guildId/channels',
  async (req, res) => {
    const token = savedToken();
    if (!token) {
      return noToken(res);
    }
    const { guildId } = req.params;
    if (!DISCORD_SNOWFLAKE_REGEX.test(guildId)) {
      return res.status(400).json({ message: 'That isn’t a server ID.' });
    }

    let channels: Channel[];
    let botId: string;
    try {
      [channels, { id: botId }] = await Promise.all([
        discordRequest<Channel[]>(token, 'GET', `/guilds/${guildId}/channels`),
        discordRequest<DiscordUser>(token, 'GET', '/users/@me'),
      ]);
    } catch (e) {
      return failed(res, e, 'could not list channels');
    }

    // Whether the bot may post in each is a guess at best without these;
    // the list is still useful without it.
    let permissionsIn: ((channel: Channel) => bigint) | undefined;
    try {
      const [guild, member] = await Promise.all([
        discordRequest<{
          id: string;
          owner_id: string;
          roles: { id: string; permissions: string }[];
        }>(token, 'GET', `/guilds/${guildId}`),
        discordRequest<{ roles: string[] }>(
          token,
          'GET',
          `/guilds/${guildId}/members/${botId}`
        ),
      ]);
      permissionsIn = (channel) =>
        channelPermissions(guild, member, botId, channel);
    } catch (e) {
      logger.debug('Discord bot setup: could not work out permissions', {
        label: 'API',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }

    const categories = new Map(
      channels
        .filter((channel) => channel.type === CATEGORY)
        .map((channel) => [channel.id, channel])
    );
    const placeOf = (channel: Channel) => {
      const category = channel.parent_id
        ? categories.get(channel.parent_id)
        : undefined;
      return [
        category ? (category.position ?? 0) + 1 : 0,
        channel.position ?? 0,
      ];
    };

    return res.status(200).json(
      channels
        .filter((channel) => POSTABLE_CHANNEL_TYPES.has(channel.type))
        .sort((a, b) => {
          const [ac, ap] = placeOf(a);
          const [bc, bp] = placeOf(b);
          return ac - bc || ap - bp;
        })
        .map(
          (channel): DiscordBotChannel => ({
            id: channel.id,
            name: channel.name,
            category:
              (channel.parent_id && categories.get(channel.parent_id)?.name) ||
              null,
            canPost: permissionsIn
              ? (permissionsIn(channel) & NEEDED_PERMISSIONS) ===
                NEEDED_PERMISSIONS
              : null,
          })
        )
    );
  }
);

/**
 * Everyone who can manage requests, and whether a press from Discord can be
 * theirs: they need a Discord user ID no other such account also has.
 */
discordBotRoutes.get('/approvers', async (_req, res) => {
  const managers = (await getRepository(User).find()).filter((user) =>
    user.hasPermission(Permission.MANAGE_REQUESTS)
  );
  const idsOf = (user: User) =>
    (user.settings?.discordIds ?? []).filter((id) =>
      DISCORD_SNOWFLAKE_REGEX.test(id)
    );
  const counts = new Map<string, number>();
  for (const id of managers.flatMap((user) => [...new Set(idsOf(user))])) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  return res.status(200).json(
    managers
      .map((user): DiscordBotApprover => {
        const ids = idsOf(user);
        return {
          id: user.id,
          displayName: user.displayName,
          avatar: user.avatar,
          linked: ids.some((id) => counts.get(id) === 1),
          shared: ids.some((id) => (counts.get(id) ?? 0) > 1),
        };
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
  );
});

discordBotRoutes.post('/test', async (req, res) => {
  const token = savedToken();
  if (!token) {
    return noToken(res);
  }
  const parsed = testBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Pick a channel first.' });
  }
  try {
    const messageId = await discordBot.sendTest(token, parsed.data.channelId);
    return res.status(200).json({ messageId });
  } catch (e) {
    return failed(res, e, 'the test message was refused');
  }
});

export default discordBotRoutes;
