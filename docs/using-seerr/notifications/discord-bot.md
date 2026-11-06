---
title: Discord Bot
description: Approve and decline requests from Discord with Seerr AI's own bot.
sidebar_position: 3.5
---

# Discord Bot

Seerr AI can run its own Discord bot. It posts each request waiting for approval to a channel you pick, with **Approve** and **Decline** buttons, and the people who can manage requests approve or decline right there. It's off unless you turn it on.

It's separate from [Discord](./discord.md) notifications, which post through a webhook and keep working as they are. A webhook can't have buttons, which is why this needs a bot. You can use both: the webhook for everything else, the bot for approvals.

## What it does

- **Posts requests waiting for approval**, looking like the Discord notification (title, poster, who asked, what for) with the two buttons under it. Only those: the bot sends nothing else.
- **Approve** approves the request as the person who pressed it, exactly as if they'd done it in Seerr AI: it's their name on the request, and it goes to Radarr, Sonarr or Lidarr as usual. The message then says **Approved by …** and loses its buttons.
- **Decline** asks for an optional reason, as Seerr AI does, then declines. Leave the reason empty to decline without one.
- **Pressed twice**, or after someone else got there first: the message keeps naming whoever decided, and the second presser is told privately, for example **Already approved by …**.
- **Approved or declined somewhere else** (in Seerr AI, from ntfy or Telegram, or another way), the message says so and loses its buttons, so none are left lying around. If that couldn't be done (the message was deleted, say), pressing an old button just says **Already approved** or **Already declined** and changes nothing.
- A blocklisted title can't be approved: pressing Approve says so, privately, and the buttons stay, since Decline still works.

## Setting it up

Go to **Settings → Notifications → Discord Bot**. The page walks through these steps one at a time and ticks each off as it's done.

1. **Create a Discord application.** Open the [Discord Developer Portal](https://discord.com/developers/applications), choose **New Application**, give it any name (Seerr AI, say) and create it.
2. **Add the bot token.** In the application, open **Bot**, choose **Reset Token** and copy the token. Paste it on the page and choose **Check and Save Token**. Seerr AI asks Discord who the token belongs to and shows the bot's name and picture, or says Discord refused it. It's saved only once Discord accepts it. The bot needs **no privileged gateway intents**, so leave those off. If **Requires OAuth2 Code Grant** is on for the bot, the page says to turn it off, because Discord won't let you invite it otherwise. While you're on the Bot page, turn off **Public Bot** too, so nobody but you can add the bot to a server; the page reminds you if it's still on.
3. **Invite the bot to your server.** **Open the Invite** opens Discord's own invite page for your bot; pick your server and choose **Authorize**. It asks only for what the bot needs in its channel: **View Channel**, **Send Messages**, **Embed Links** and **Read Message History** (to fetch a message again to take its buttons away). **Refresh** then shows how many servers the bot is in.
4. **Pick the channel.** Choose the server and the channel. Channels where the bot lacks one of those permissions are marked; pick another, or give the bot (or its role) the permissions in that channel. **Save Channel**.
5. **Link the approvers.** See below. The page lists everyone who can manage requests and whether each can approve from Discord yet.
6. **Send a test, then turn it on.** **Send Test Message** posts a message with the buttons too, but pressing them only says it's a test, and whether that Discord account is linked (a handy check for step 5). Then tick **Enable Discord Bot** and save. **Embed Poster** adds the title's poster to the message, as for Discord notifications.

At the top of the page, the bot's status says whether it's connected, connecting, trying again after losing the connection, or stopped because Discord refused it (a reset token, for one). After fixing what it says, save again to retry. If the last request couldn't be posted (the channel was deleted, or the bot lost a permission there), the status says so until a post works again.

## Who can press the buttons

A press counts as the Seerr AI account whose **Discord user ID** matches the person who pressed, and only if that account can manage requests. Discord itself says who pressed, so nobody can press as someone else.

Each person who approves adds their Discord user ID in **Profile → Settings → Notifications → Discord**. To copy it: in Discord, turn on **Developer Mode** (**User Settings → Advanced**), then right-click your own name and choose **Copy User ID**. The same field is used to mention people in Discord notifications; an account can have several.

Anyone else who presses (someone without a linked account, or whose account can't manage requests) is told, privately, that they can't approve there, and nothing changes. Anyone can type any ID into their own profile, so if more than one account that can manage requests has the same Discord user ID, presses from that Discord account count for **none** of them; the page flags it in step 5.

## Security notes

- **No open port.** Seerr AI connects out to Discord (the Gateway, over a WebSocket) and hears the presses that way, so nothing has to reach your server from outside, and there's no address anyone could call to approve. Its calls to Discord's API go through **Settings → Network → HTTP(S) Proxy** when that's on.
- **The token stays on the server.** It's saved in Seerr AI's settings and never sent back to the browser: the page only knows whether one is saved. Anyone with the token can act as the bot, so keep it to yourself; if it gets out, **Reset Token** in the Developer Portal and paste the new one.
- **Buttons carry no secrets**, only which request and which button. What a press can do depends on who pressed it, and presses only count on the bot's own request messages in the server you chose; anywhere else (another server, a direct message) they're refused.
- **Turn off Public Bot** in the Developer Portal, so only you can add the bot to servers.
- **Use a bot of its own.** If another program runs the same bot, both get every press and only one can answer it.
- Everyone who can see the channel sees the requests in it (titles, who asked). Pick a channel only the right people can see.
- Seerr AI keeps which message belongs to which request only while it's needed: once a request is approved or declined its messages are let go, and the nightly database maintenance clears any left over a day later (taking their buttons away first when the bot is on). Switching to another application's token forgets the old bot's messages, as the new bot can't edit them.
- Turning the bot off disconnects it. Buttons already posted then stop working (Discord says the interaction failed) until it's on again.
