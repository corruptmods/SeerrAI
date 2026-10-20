---
title: Webhook
description: Configure webhook notifications.
sidebar_position: 4
---

# Webhook

The webhook notification agent enables you to send a custom JSON payload to any endpoint for specific notification events.

## Configuration

### Support URL Variables (optional)

With this on, the **Webhook URL** can use the [template variables](#template-variables) below, for example `https://example.com/hook?tmdb={{media_tmdbid}}`. Each value is URL-encoded, a variable with no value for the notification is left empty, and the test notification fills every variable with `test`. The ones under [Special](#special) only work as keys in the JSON payload. It's off unless you turn it on.

### Webhook URL

The URL you would like to post notifications to. Your JSON will be sent as the body of the request.

### Authorization Header (optional)

:::info
This is typically not needed. Please refer to your webhook provider's documentation for details.
:::

This value will be sent as an `Authorization` HTTP header.

### Custom Headers (optional)

You can add additional custom HTTP headers to be sent with each webhook request. This is useful for API keys, custom authentication schemes, or any other headers your webhook endpoint requires.

- Click "Add Header" to add a new header
- Enter the header name and value

:::warning
You cannot configure both the **Authorization Header** field and a custom `Authorization` header in Custom Headers at the same time. You must choose one method.
:::

### JSON Payload

Customize the JSON payload to suit your needs. Seerr provides several [template variables](#template-variables) for use in the payload, which will be replaced with the relevant data when the notifications are triggered.

## Template Variables

### General

| Variable                | Value                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `{{notification_type}}` | The type of notification (e.g. `MEDIA_PENDING` or `ISSUE_COMMENT`)                                                                  |
| `{{event}}`             | A friendly description of the notification event                                                                                    |
| `{{subject}}`           | The notification subject (typically the media title)                                                                                |
| `{{message}}`           | The notification message body (the media overview/synopsis for request notifications; the issue description for issue notificatons) |
| `{{image}}`             | The notification image (typically the media poster, or the album's cover for music)                                                 |

### Notify User

These variables are for the target recipient of the notification.

| Variable                                 | Value                                                                                        |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `{{notifyuser_username}}`                | The target notification recipient's username                                                 |
| `{{notifyuser_email}}`                   | The target notification recipient's email address                                            |
| `{{notifyuser_avatar}}`                  | The target notification recipient's avatar URL                                               |
| `{{notifyuser_settings_discordIds}}`     | The target notification recipient's Discord ID(s) as a JSON array (if set)                   |
| `{{notifyuser_settings_telegramChatId}}` | The target notification recipient's Telegram Chat ID (if set)                                |

:::info
The `notifyuser` variables are not defined for the following request notification types, as they are intended for application administrators rather than end users:

- Request Pending Approval
- Request Automatically Approved
- Request Processing Failed

On the other hand, the `notifyuser` variables _will_ be replaced with the requesting user's information for the below notification types:

- Request Approved
- Request Declined
- Request Available

If you would like to use the requesting user's information in your webhook, please instead include the relevant variables from the [Request](#request) section below.
:::

### Special

The following variables must be used as a key in the JSON payload (e.g., `"{{extra}}": []`).

| Variable      | Value                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `{{media}}`   | The relevant media object                                                                                                      |
| `{{request}}` | The relevant request object                                                                                                    |
| `{{issue}}`   | The relevant issue object                                                                                                      |
| `{{comment}}` | The relevant issue comment object                                                                                              |
| `{{extra}}`   | The "extra" array of additional data for certain notifications (e.g., season/episode numbers for series-related notifications) |

#### Media

The `{{media}}` will be `null` if there is no relevant media object for the notification.

These following special variables are only included in media-related notifications, such as requests.

| Variable                    | Value                                                                                                          |
| ----------------------------| -------------------------------------------------------------------------------------------------------------- |
| `{{media_type}}`            | The media type (`movie`, `tv` or `music`)                                                                      |
| `{{media_imdbid}}`          | The media's IMDb ID                                                                                            |
| `{{media_tmdbid}}`          | The media's TMDB ID (`0` for music)                                                                            |
| `{{media_mbid}}`            | For music, the artist's MusicBrainz ID; empty otherwise                                                        |
| `{{music_albums}}`          | For music, the titles of the albums asked for, one per line; empty otherwise                                   |
| `{{media_tvdbid}}`          | The media's TheTVDB ID                                                                                         |
| `{{media_status}}`          | The media's availability status (`UNKNOWN`, `PENDING`, `PROCESSING`, `PARTIALLY_AVAILABLE`, or `AVAILABLE`)    |
| `{{media_status4k}}`        | The media's 4K availability status (`UNKNOWN`, `PENDING`, `PROCESSING`, `PARTIALLY_AVAILABLE`, or `AVAILABLE`) |
| `{{media_jellyfinMediaId}}` | The media's Jellyfin Media ID (its Emby one when only Emby has it)                                             |
| `{{media_embyMediaId}}`     | The media's Emby Media ID                                                                                      |
| `{{media_plexRatingKey}}`   | The media's Plex ratingKey, if available (for standard library match)                                          |
| `{{media_plexRatingKey4k}}` | The media's Plex ratingKey for 4K match, if available                                                          |

#### Request

The `{{request}}` will be `null` if there is no relevant media object for the notification.

The following special variables are only included in request-related notifications.

| Variable                                  | Value                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| `{{request_id}}`                          | The request ID                                                                 |
| `{{requestedBy_username}}`                | The requesting user's username                                                 |
| `{{requestedBy_email}}`                   | The requesting user's email address                                            |
| `{{requestedBy_avatar}}`                  | The requesting user's avatar URL                                               |
| `{{requestedBy_jellyfinUserId}}`          | The requesting user's Jellyfin User ID (else their Emby one)                   |
| `{{requestedBy_embyUserId}}`              | The requesting user's Emby User ID                                             |
| `{{requestedBy_settings_discordIds}}`     | The requesting user's Discord ID(s) as a JSON array (if set)                   |
| `{{requestedBy_settings_telegramChatId}}` | The requesting user's Telegram Chat ID (if set)                                |
| `{{decline_reason}}`                      | Why the request was declined, if a reason was given (declined requests only)   |

#### Issue

The `{{issue}}` will be `null` if there is no relevant media object for the notification.

The following special variables are only included in issue-related notifications.

| Variable                                 | Value                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| `{{issue_id}}`                           | The issue ID                                                                   |
| `{{issue_type}}`                         | The issue's type (`VIDEO`, `AUDIO`, `SUBTITLES` or `OTHER`)                    |
| `{{issue_status}}`                       | The issue's status (`OPEN` or `RESOLVED`)                                      |
| `{{reportedBy_username}}`                | The requesting user's username                                                 |
| `{{reportedBy_email}}`                   | The requesting user's email address                                            |
| `{{reportedBy_avatar}}`                  | The requesting user's avatar URL                                               |
| `{{reportedBy_settings_discordIds}}`     | The reporting user's Discord ID(s) as a JSON array (if set)                    |
| `{{reportedBy_settings_telegramChatId}}` | The requesting user's Telegram Chat ID (if set)                                |

#### Comment

The `{{comment}}` will be `null` if there is no relevant media object for the notification.

The following special variables are only included in issue comment-related notifications.

| Variable                                  | Value                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| `{{comment_message}}`                     | The comment message                                                            |
| `{{commentedBy_username}}`                | The commenting user's username                                                 |
| `{{commentedBy_email}}`                   | The commenting user's email address                                            |
| `{{commentedBy_avatar}}`                  | The commenting user's avatar URL                                               |
| `{{commentedBy_settings_discordIds}}`     | The commenting user's Discord ID(s) as a JSON array (if set)                   |
| `{{commentedBy_settings_telegramChatId}}` | The commenting user's Telegram Chat ID (if set)                                |
