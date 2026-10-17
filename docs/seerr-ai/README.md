# Seerr AI guide

Seerr AI is a fork of [Seerr](https://github.com/seerr-team/seerr). These pages cover what the fork adds. For everything Seerr already did (setting up Plex, Jellyfin or Emby, Radarr and Sonarr, users, notifications), see [docs.seerr.dev](https://docs.seerr.dev).

## For everyone

- **[Requests and downloads](./requests-and-downloads.md)**: when a request should arrive, what each status pill means, single episodes, new seasons, anime.
- **[Music](./music.md)**: finding and requesting albums, how they reach your library through Lidarr, and setting it up.
- **[Discover and lists](./discover-and-lists.md)**: your own home page, Suggested for You, filtering and requesting several titles, shared watch lists, Roulette, the calendar.
- **[AI](./ai.md)**: AI Search (from text or a photo), Pick for the Room, Catch Me Up, and what AI can and can't do.
- **[Subtitles and fixing problems](./subtitles-and-autofix.md)**: subtitles from Bazarr, transcription, and problems fixed from a report.
- **[Your account](./account.md)**: passkeys, turning features off for yourself, notifications.
- **[Themes](./themes.md)**: light or dark, your accent colour, the dark background and a few extras, seasonal themes, theme files and custom CSS.

## For admins

- **[Installing and updating](./install.md)**: building, updating with patches, migrations, backups.
- **[Plex, Jellyfin and Emby together](./media-servers.md)**: connecting several media servers, the primary one, sign-in, linking accounts, removing a server.
- **[Single sign-on](./single-sign-on.md)**: letting people sign in with Authentik, Authelia, Keycloak, Pocket ID or Google.
- **[Backfill and the admin agent](./backfill-and-agent.md)**: getting what Sonarr and Radarr can't find.
- **[Keeping it healthy](./health.md)**: the Health page and alerts, Plex Match Check, Anime Check, the offline page.
- **[Configuration reference](./configuration.md)**: every setting the fork adds, its default, the jobs and the feature switches.

Inside the app, **Settings → How It Works** gives admins the same overview in one page: the path of a request, every status pill, what steps in when a title is stuck, and where to look when something is wrong.

## Turning things off

Almost everything here is an optional feature. An admin can turn one off for everyone in **Settings → Features**, and anyone can turn one off for themselves in **Profile → Settings → Features**. A feature turned off is off on the server too, not only hidden. The [configuration reference](./configuration.md#feature-switches) lists them all.

## What it adds, in one table

| | |
|---|---|
| **Backfill** | Searches Prowlarr for series and movies Sonarr and Radarr gave up on, checks every file in a pack with Sonarr or Radarr, and imports only what an admin approves. |
| **Admin agent** | An AI that looks further when Backfill finds nothing, within limits you set. On its own it never replaces a file on disk; when you ask, it can replace files, block release groups and more, once you approve. |
| **Status that says why** | Waiting on a delay profile (and for how long), queued, stalled, verifying, unpacking, importing, adding to Plex. Live progress from SABnzbd, NZBGet, qBittorrent, Transmission, Deluge and rTorrent. |
| **Arrival estimates** | "Digital release expected 3 Nov", "Released — searching, usually arrives within 2 days here", or time left while downloading. |
| **Music** | Request albums, EPs or a whole discography through Lidarr, as one request; download progress, availability from your music libraries, and a notification when it's all here. |
| **Several media servers** | Plex, Jellyfin and Emby connected at once: available on any, sign in with any, Play on each. |
| **Health** | Every connected service checked, problems listed with how to fix them, and an alert when something newly breaks. |
| **Plex Match Check** | Nightly: folders Plex matched to a different title than Sonarr or Radarr has in them. |
| **AI** | Claude, OpenAI or a model on your own server. Search, group picks, recaps, deletion reviews, issue fixes, log explanations. |
| **Watch lists** | Shared lists with "up next" for each series, list activity, import from text, Roulette, "Finished watching?". |
| **Your home page** | Hide rows for yourself; arrange your own sidebar and phone menu; Suggested for You; Deleting Soon; filter any poster grid; request several titles at once. |
| **Series** | Request one episode; get each new season as it premieres; see which episodes are here. |
| **Anime** | One rule for what counts as anime; anime folders, profiles and series type in Sonarr and Radarr; a nightly check. |
| **Subtitles** | See and replace subtitles through Bazarr, or transcribe them with Whisper. |
| **Maintainerr** | "Deleting in N days" badges, a Deleting Soon row and a Keep button. |
| **Passkeys** | Sign in without a password. |
| **Single sign-on** | Sign in with Authentik, Authelia, Keycloak, Pocket ID, Google or another OpenID Connect provider. |
| **Notifications** | Bursts gathered into one, missed ones caught up, list activity, Backfill and Health. |
