---
title: Discord
description: Configure Discord notifications.
sidebar_position: 3
---

# Discord

The Discord notification agent enables you to post notifications to a channel in a server you manage.

:::info
Users can optionally opt-in to being mentioned in Discord notifications by configuring their [Discord user ID](https://support.discord.com/hc/en-us/articles/206346498-Where-can-I-find-my-User-Server-Message-ID-) in their user settings.
:::

## Configuration

### Embed Poster

Notifications about a film, series or album show its poster (or the album's cover) as a small picture in the corner of the message. It's on unless you turn it off.

### Webhook URL

You can find the webhook URL in the Discord application, at **Server Settings &rarr; Integrations &rarr; Webhooks**.

### Notification Role ID (optional)

If a role ID is specified, it will be included in the webhook message. See [Discord role ID](https://support.discord.com/hc/en-us/articles/206346498-Where-can-I-find-my-User-Server-Message-ID).

### Bot Username (optional)

If you would like to override the name you configured for your bot in Discord, you may set this value to whatever you like!

### Bot Avatar URL (optional)

Similar to the bot username, you can override the avatar for your bot.

### Thread ID (optional)

To post in a thread instead of the webhook's channel, such as a post in a forum channel, set this to the thread's ID. With Developer Mode on in Discord (**User Settings → Advanced**), right-click the thread and copy its ID. Leave it empty to post in the channel itself.

### Enable Mentions

When this is on, a notification mentions the people it's about, so Discord alerts them: the person who made the request or reported the issue, and admins for notifications meant for them. Each person is only mentioned if they've added their Discord user ID in their own notification settings and turned that notification on for Discord. It's on unless you turn it off.

With it off, nobody is mentioned by name. The **Notification Role ID** above is still mentioned either way.

### Use Notification Recipient Locale

When enabled, notifications will be sent in the language of the user who triggered the notification (e.g., the user who made the request or reported the issue) based on their display language setting. When disabled, the **Notification Language** setting below is used instead.

### Notification Language

Sets the language for all notifications sent to this Discord channel. This option is only available when **Use Notification Recipient Locale** is disabled.