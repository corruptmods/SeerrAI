# Your account

[← Seerr AI guide](./README.md)

## Passkeys

Sign in with your device's fingerprint, face or PIN instead of a password: **Sign in with a passkey** on the sign-in page. Add, rename or remove passkeys in **Profile → Settings → Passkeys**. If you sign in without one on a device that can make one, a banner offers to add it; **Not now** puts it off for two weeks (switch: `passkeyPrompt`).

Passkeys belong to the server's address (Settings → General → Application URL). One made there can't be used from another address.

Admins who manage users can remove someone's passkeys, for a lost device, but can't add or rename them.

## Turning features off for yourself

**Profile → Settings → Features** lists every optional feature. Turning one off there hides it for you, everywhere. A feature an admin turned off for everyone stays off. See the [list of switches](./configuration.md#feature-switches).

## Your home page

Use the pencil button on Discover. See [Discover and lists](./discover-and-lists.md#your-own-home-page).

## Notifications

- **Several at once become one**: when eight titles arrive together, you get "8 titles are ready to watch", not eight notifications. Approvals, declines and watchlist requests are gathered the same way. Admins and channels like Discord still get each one.
- **Nothing is missed**: a notification that didn't go out (the server restarted, say) is sent later, once.
- **A series that is still airing**: you're told once everything that had aired when you asked for it is here.
- **On your phone** (web push): when a title is available or failed, list activity, a Plex sign-in that expired, and for admins, Backfill and Health.
- **When it should arrive**: approval notifications say when the title is expected.

## Plex sign-in

If Plex stops accepting your sign-in, your Plex watchlist stops syncing. You get one notification and a banner saying so; signing out and back in with Plex fixes it.

Admins can have everyone the Plex server is shared with get an account automatically (**Settings → Users → Auto-Import Plex Users**, hourly). Someone an admin deletes isn't imported again.
