# Your account

[← Seerr AI guide](./README.md)

Everything here is in **Profile → Settings** (your picture, top right → **Settings**).

## Your email

An email you set on your own account (**Profile → Settings → General**) counts as confirmed once you open the link sent to it. The link is sent when email notifications are set up and the Application URL is set, and it works for 7 days. Emails set by an admin, brought by Plex or single sign-on, or that are your Jellyfin or Emby username, count as confirmed straight away. An email typed in when signing up with Jellyfin or Emby gets a link too.

Until it's confirmed, the address isn't kept for you: if someone later signs in with Plex or single sign-on using that email, it moves to their account, and you lose password sign-in until an admin sets an email for you. Without email notifications set up, ask an admin to set your email instead.

## Default quality profiles

If you may choose advanced request options, **Profile → Settings → General** has **Default Quality Profiles**: for each server, the quality profile your requests use, and one for anime where the server has an anime profile. It's picked first in the request window, and used for requests you make elsewhere, such as Siri or AI Search. **Server default** leaves it to the server. See [Quality profiles and folders](./requests-and-downloads.md#quality-profiles-and-folders).

## Passkeys

Sign in with Face ID, Touch ID, Windows Hello or a security key instead of a password.

1. Open **Profile → Settings → Passkeys**.
2. Press **Add a Passkey** and follow your device.
3. Next time, press **Passkey** (or **Sign in with a passkey**) on the sign-in page.

Add one on each device you use; a passkey saved in a password manager works on your other devices too. **Rename** or delete them on the same page. If you sign in without one on a device that could make one, a banner offers it; **Not now** puts it off for two weeks.

Passkeys belong to the server's address (Settings → General → Application URL): one made there doesn't work from another address. Admins who manage users can remove someone's passkey (for a lost device) but can't add one.

## Linked accounts

**Profile → Settings → Linked Accounts** lists your accounts on Plex, Jellyfin and Emby, and any single sign-on providers. **Link Account** adds one, so you can sign in with it. See [several media servers](./media-servers.md#linking-your-other-accounts) and [single sign-on](./single-sign-on.md#linking-a-provider-to-your-account).

## API keys

Let an app or script, such as Home Assistant or a phone app, use Seerr AI as you. The **API Keys** page appears once an admin turns keys on.

1. Open **Profile → Settings → API Keys** and press **Make an API Key**.
2. Give it a **Name** (what it's for) and choose when it **Expires**: 30 days, 90 days, a year, or **Never**.
3. Press **Make Key**, then **Copy**. Put it straight into the app: nobody can see it again, not even an admin.

The app sends it in the `X-Api-Key` header. A key can do exactly what you can, nothing more, so keep it like a password.

The list shows when each key was made, last used and expires. **Revoke** stops one at once; revoke a key when you stop using its app. You can have 10. An expired key stays listed as **Expired**, so you can see which app stopped; it's cleared once it has been expired a month and you make another.

Keys also stop working while an admin has keys turned off, and when you can no longer sign in (for example, no longer shared on Plex). Deleting your account deletes them.

## Siri

**Profile → Settings → Siri** sets up "Fix this show": add the shortcut, then give it the server address and a Siri key, which can only report problems with what you're watching. See [Reporting with Siri](./siri.md).

## Notifications

**Profile → Settings → Notifications** sets what reaches you and where: **Email**, **Web Push** (your phone or browser) and **Telegram** when an admin has set them up, and **Discord**, **Pushbullet** or **Pushover** with your own details. Tick the kinds you want on each.

What Seerr AI adds:

- **Bursts become one**: eight titles arriving together send "8 titles are ready to watch". Approvals, declines and watchlist requests are gathered the same way.
- **Nothing missed**: a notification that didn't go out (a restart, say) is sent later, once.
- **Series still airing**: you're told once everything that had aired when you asked is here.
- **When it should arrive**: approval notifications say when.
- **List Activity**: changes on a watch list shared with you.
- **Request Failed**: one of your own requests failed. Admins choose this apart from **Request Processing Failed**, which is about everyone else's.
- **Playlist Updates**: songs from a playlist you imported couldn't be got, or the playlist can no longer be read from its service.
- **Leaving Soon**: something you requested is about to be deleted by Maintainerr, with how many days are left. You're told once for each date; a title kept and set to go later is told again.
- **Web Push** has every kind. Until you choose, it sends what it always has: availability, failures and what's only yours. Approvals, declines and issues are yours to turn on.
- On **Discord**, kinds the admin turned off for everyone are shown greyed, so you can see what's missing.
- **Declined with a reason**: the reason is in the notification.
- Admins also get **Backfill**, **Health** and **Wrong Match**.

Admins set up the services themselves in Settings → Notifications; see [Notifications](../using-seerr/notifications/).

## Turning features off for yourself

**Profile → Settings → Features** lists every optional feature, music included. Turning one off hides it for you everywhere. One an admin turned off for everyone stays off. See the [list](./configuration.md#feature-switches).

## How it looks

**Profile → Settings → Appearance**: light or dark, accent colour and more. See [Themes](./themes.md).

## Your home page and menu

The pencil button on Discover. See [Discover and lists](./discover-and-lists.md#your-own-home-page).

## Trakt watchlist

Once an admin has set up Trakt, anyone allowed to auto-request can enter their Trakt username in **Profile → Settings → General**. Titles added to your public Trakt watchlist are then requested for you every few minutes, with **Auto-Request Movies** and **Auto-Request Series**, on any media server. Only the 20 most recently added are looked at. Removing a title and adding it back requests it again; something deleted isn't requested again just because it's still listed.

## Plex sign-in

If Plex stops accepting your sign-in, your Plex watchlist stops syncing. You get a notification and a banner; signing out and back in with Plex fixes it.

Admins can give everyone the Plex server is shared with an account automatically (**Settings → Users → Auto-Import Plex Users**, hourly). Someone an admin deletes isn't imported again.
