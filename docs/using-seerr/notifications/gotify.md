---
title: Gotify
description: Configure Gotify notifications.
sidebar_position: 5
---

# Gotify

## Configuration

### Embed Poster

Notifications about a film, series or album show its poster (or the album's cover) under the message in Gotify's web page, and as a large picture in the Android app's notification. It's off unless you turn it on.

### Server URL

Set this to the URL of your Gotify server.

### Application Token

Add an application to your Gotify server, and set this field to the generated application token.

### Priority

How urgent Gotify should treat Seerr AI's notifications, as a number. In Gotify's Android app:

- **0**: no notification at all; the message only waits in the app.
- **1 to 3**: an icon in the notification bar, silently.
- **4 to 7**: an icon and a sound.
- **8 to 10**: an icon, a sound and a vibration.

It has to be a whole number from 0 to 10. On a new server it starts at **5**, a normal notification with a sound; a Gotify you set up before keeps the priority you saved, so check it if your notifications arrive silently. See [Gotify's guide to priorities](https://gotify.net/docs/priority) for other apps.

:::info
Please refer to the [Gotify API documentation](https://gotify.net/docs) for more details on configuring these notifications.
:::

### Notification Language

Sets the language for notifications sent to this Gotify server.
