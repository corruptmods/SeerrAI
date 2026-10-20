---
title: Telegram
description: Configure Telegram notifications.
sidebar_position: 10
---

# Telegram

:::info
Users can optionally configure personal notifications in their user settings.

User notifications are separate from system notifications, and the available notification types are dependent on user permissions.
:::

## Configuration

### Embed Poster

Notifications about a film, series or album are sent as its poster (or the album's cover), with the message underneath. It's on unless you turn it off.

Telegram only allows 1,024 characters under a picture, so a longer notification is sent as a plain message without the poster.

:::info
In order to configure Telegram notifications, you first need to [create a bot](https://telegram.me/BotFather).

Bots **cannot** initiate conversations with users, so users must have your bot added to a conversation in order to receive notifications.
:::

### Bot Username (optional)

If this value is configured, users will be able to click a link to start a chat with your bot and configure their own personal notifications.

The bot username should end with `_bot`, and the `@` prefix should be omitted.

### Bot Authorization Token

At the end of the bot creation process, [@BotFather](https://telegram.me/botfather) will provide an authentication token.

### Chat ID

To obtain your chat ID, simply create a new group chat, add [@get_id_bot](https://telegram.me/get_id_bot), and issue the `/my_id` command.

### Thread/Topic ID (optional)

If the group has Topics turned on, set this to a topic's ID to post there. Leave it empty to post in the group's General topic. It has to be a whole number, above zero. People who get their own Telegram notifications can choose a topic in their notification settings too.

### Send Silently (optional)

Optionally, notifications can be sent silently. Silent notifications send messages without notification sounds.
