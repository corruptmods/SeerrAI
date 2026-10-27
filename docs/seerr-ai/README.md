# Seerr AI guide

Seerr AI is a fork of [Seerr](https://github.com/seerr-team/seerr). These pages cover what it adds. For what Seerr already did (setting up a media server, Radarr, Sonarr, users), see [docs.seerr.dev](https://docs.seerr.dev).

## For everyone

- **[Your account](./account.md)**: passkeys, linked accounts, API keys, notifications, turning features off for yourself.
- **[Themes](./themes.md)**: light or dark, accent colours, seasonal themes, theme files.
- **[Requests and downloads](./requests-and-downloads.md)**: when a request should arrive, what each status means, failed requests, single episodes, anime.
- **[Discover and lists](./discover-and-lists.md)**: your home page and menu, the Anime page, leaving out streaming services, watch lists, the calendar.
- **[Music](./music.md)**: finding and requesting albums and songs, and the charts.
- **[Plex, Jellyfin and Emby together](./media-servers.md)**: Play on each server, linking your accounts.
- **[Single sign-on](./single-sign-on.md)**: signing in with Authentik, Google and the like.
- **[AI](./ai.md)**: AI Search, Pick for the Room, Catch Me Up.
- **[Subtitles and fixing problems](./subtitles-and-autofix.md)**: subtitles from Bazarr, and problems fixed from a report.
- **[Reporting with Siri](./siri.md)**: "Fix this show" while something is playing.

## For admins

- **[Installing and updating](./install.md)**: the image, updates, backups, trying a beta.
- **[Plex, Jellyfin and Emby together](./media-servers.md#for-admins)**: connecting servers, the primary one, removing one.
- **[Single sign-on](./single-sign-on.md#setting-it-up-admins)**: adding providers, sign-ups, who can sign in.
- **[Music](./music.md#setting-it-up-admins)**: Lidarr, music libraries, limits.
- **[Backfill and the admin agent](./backfill-and-agent.md)**: getting what Sonarr, Radarr and Lidarr can't find.
- **[Download Check](./download-check.md)**: fakes, wrong titles and stuck imports, sorted out.
- **[Keeping it healthy](./health.md)**: the Health page, alerts, Match Check, Anime Check.
- **[Notifications](../using-seerr/notifications/)**: each notification service and its settings.
- **[Configuration reference](./configuration.md)**: every setting the fork adds, its default, the jobs and the feature switches.

In the app, **Settings → How It Works** gives admins the same overview on one page.

## Turning things off

Almost everything here is optional. Admins turn a feature off for everyone in **Settings → Features** (music in **Settings → Music**); anyone can turn one off for themselves in **Profile → Settings → Features**. Off means off on the server too. The [list of switches](./configuration.md#feature-switches) has them all.

## At a glance

| | |
|---|---|
| **Themes** | Light or dark, accent colours, dark backgrounds, seasonal themes, theme files, custom CSS. |
| **Several media servers** | Plex, Jellyfin and Emby at once: available on any, sign in with any, Play on each. |
| **Music** | Albums, whole discographies or single songs through Lidarr; Top Songs, Trending, Top Albums and Top Artists from Apple Music's charts; rows of your own. |
| **Single sign-on** | Authentik, Authelia, Keycloak, Pocket ID, Google or any OpenID Connect provider. |
| **Passkeys and API keys** | Sign in without a password; personal keys for apps and scripts. |
| **Status that says why** | Waiting on a delay profile, queued, stalled, unpacking, importing, adding to Plex; live progress from six download clients. |
| **Arrival estimates** | "Digital release expected 3 Nov", or time left while downloading. |
| **Failed requests** | Say why, with Retry and Edit. |
| **Backfill and the admin agent** | Find what Sonarr, Radarr and Lidarr can't; nothing changes without approval. |
| **Health and Match Check** | Every service checked, alerts when something breaks, wrong matches caught. |
| **AI** | Claude, OpenAI or your own model: search for films, series and music, group picks, recaps, fixes for problems you describe, log explanations. |
| **Your home page** | Hide rows, arrange your menu, Suggested for You, Anime, leave out streaming services. |
| **Watch lists** | Shared lists with "up next" per series, activity, import, Roulette. |
| **Series and anime** | Request one episode; get new seasons as they premiere; one rule for what's anime. |
| **Subtitles** | See, replace or transcribe subtitles through Bazarr, with what Bazarr is doing shown as it works. |
| **Maintainerr** | "Deleting in N days" badges, a Deleting Soon row and Keep. |
| **Notifications** | Bursts gathered into one, missed ones caught up, decline reasons, Backfill, Health and Wrong Match. |
