---
title: Pushover
description: Configure Pushover notifications.
sidebar_position: 8
---

# Pushover

:::info
Users can optionally configure personal notifications in their user settings.

User notifications are separate from system notifications, and the available notification types are dependent on user permissions.
:::

## Configuration

### Embed Poster

Notifications about a film, series or album come with its poster (or the album's cover) attached, shown in the Pushover app. Seerr AI fetches the picture from TMDB (or the Cover Art Archive for music) and sends it along; if it can't, the notification goes without it. It's on unless you turn it off.

### Application/API Token

[Register an application](https://pushover.net/apps/build) and enter the API token in this field. (You can give it Seerr AI's own icon, from the [public folder of Seerr AI's repository](https://github.com/corruptmods/SeerrAI/tree/main/public), such as `android-chrome-192x192.png`.)

For more details on registering applications or the API token, please see the [Pushover API documentation](https://pushover.net/api#registration).

### User Key

Set this to the user key for your Pushover account. Alternatively, you can set this to a group key to deliver notifications to multiple users.

For more details, please see the [Pushover API documentation](https://pushover.net/api#identifiers).

### Notification Sound

The sound Pushover plays for Seerr AI's notifications. Left on **Device Default**, as it starts, each device plays the sound chosen in its own Pushover app.

The list of sounds comes from Pushover, using your Application API Token, so it stays greyed out until a token has been saved: save once, and it fills in. People who get their own Pushover notifications choose their own sound in their notification settings.
