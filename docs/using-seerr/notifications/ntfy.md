---
title: ntfy.sh
description: Configure ntfy.sh notifications.
sidebar_position: 6
---

# ntfy.sh

## Configuration

### Embed Poster

Notifications about a film, series or album come with its poster (or the album's cover) attached as a picture, which the ntfy app loads from TMDB (or the Cover Art Archive for music). It's on unless you turn it off.

### Server Root URL

Set this to the URL of your ntfy.sh server.

### Topic

Set this to the topic you want to send notifications to.

### Tags (optional)

Set this to a comma-separated list of [ntfy tags](https://docs.ntfy.sh/publish/#tags-emojis) to apply to notifications (for example, `eyes` or `eyes,warning`).

### Username + Password authentication (optional)

Set this to the username and password for your ntfy.sh server.

### Token authentication (optional)

Set this to the token for your ntfy.sh server.

### Priority (optional)

Set the priority level for notifications. Options range from Minimum (1) to Urgent (5), with Default (3) being the standard level. Higher priority notifications may bypass Do Not Disturb settings on some devices.

:::info
Please refer to the [ntfy.sh API documentation](https://docs.ntfy.sh/) for more details on configuring these notifications.
:::

### Notification Language

Sets the language for notifications sent to this ntfy server.

### Approve and Decline Buttons (optional)

Adds **Approve** and **Decline** to notifications about requests waiting for approval. Off unless you turn it on.

The ntfy app sends a press straight from the phone to Seerr AI's **Application URL** (Settings → General), so that has to be set, and the phone has to be able to reach it: from outside your home too, if you want to approve from there. Without an Application URL the buttons are left off.

The phone has no Seerr AI sign-in, so each button carries its own key instead: it works once, only for that request and that choice, and stops working after 7 days or once the request is no longer waiting. It isn't in the address, so it doesn't end up in your reverse proxy's logs. Turning the buttons off, or choosing another account under **Approve As**, stops every button already sent.

Anyone who can read the topic can press them, so keep the topic to people who may approve requests, ideally with [access control](https://docs.ntfy.sh/config/#access-control) on your ntfy server.

### Approve As

Whose approval the buttons give, as if they had approved in Seerr AI themselves: it's their name on the request. Only accounts that can manage requests are listed; it's the owner's account until you choose. If that account later loses the permission, the buttons stop working and say so.

