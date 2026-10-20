# What's new in Seerr AI

Newest first. **Coming next** is on the `dev` branch and not released yet; the [guide](./docs/seerr-ai/README.md) explains each feature.

## Coming next

## 2.0.0-beta.1 (unreleased)

A preview of Seerr AI 2.0: themes, single sign-on, Plex, Jellyfin and Emby together, music, personal API keys and more.

### New

- **Themes**: light or dark, accent colours, dark backgrounds and extras, chosen by each person; seasonal themes, theme files and custom CSS. ([guide](./docs/seerr-ai/themes.md))
- **Single sign-on** with Authentik, Authelia, Keycloak, Pocket ID, Google or any OpenID Connect provider, with rules for who may sign in. ([guide](./docs/seerr-ai/single-sign-on.md))
- **Plex, Jellyfin and Emby together**, in any combination, from Settings → Media Servers, with Play on each server. ([guide](./docs/seerr-ai/media-servers.md))
- **Music**: request albums or a whole discography through Lidarr, as one request. ([guide](./docs/seerr-ai/music.md))
- **Personal API keys** for apps and scripts, off until an admin turns them on. ([guide](./docs/seerr-ai/account.md#api-keys))
- **Leave out streaming services** in Filters and in custom streaming rows.
- **Anime** on Discover: an Anime This Season row and an Anime page.
- **Wrong-match alerts**: admins hear within minutes when a server files a new request under the wrong title.
- **Recover failed requests**: a request whose Radarr, Sonarr or Lidarr server is gone says why, with Retry and Edit.
- **Requested by** on title pages.
- **Decline with a reason**, shown to whoever asked.
- **Override rules by age rating.**
- **Leave out anime made in** chosen countries (Settings → Services → Anime).
- **Arrange your own menu**: reorder and hide sidebar items.
- **Search by kind**: All, Movies, Series and Music.
- **Signed images** with a list of what's inside. ([how to check](./docs/seerr-ai/install.md#checking-an-image))

### Changed

- Settings → Media Servers is where Plex, Jellyfin and Emby are connected; connecting one lists its libraries straight away.
- **Enable Proxy Support** trusts only proxies on your network or Tailscale; add **Trust Cloudflare** or **Also Trust These Proxies** for others. ([guide](./docs/using-seerr/settings/network.md#enable-proxy-support))
- The sign-in pages show the Seerr AI logo, and the sign-in buttons line up.
- Posters load before you scroll to them.
- The admin agent describes its steps in plain words.
- A failed Backfill download says what replaced it; when the agent started it, the agent looks for another.
- Notifications: Gotify priority 0 to 10, List Activity off channel pages, a 15-second limit per service.
- Logs say once when Radarr, Sonarr or Lidarr stops answering, and once when a server skips titles in a scan.
- About 15,600 more bits of text translated.

### Fixed

- A few bad single sign-on attempts can't lock everyone out.
- Passkeys work for single sign-on accounts with password sign-in off.
- Changing a provider's issuer URL ends old links, so nobody signs in as someone else.
- Plex sign-in works when the browser blocks its window, and says what went wrong.
- Import Plex Users no longer changes other people's details or stops halfway.
- Anime override rules follow Seerr's own idea of anime.
- Series and music limits on SQLite count the first day of the period.
- Approve and Delete in the Manage panel say what went wrong.
- Declining several requests at once resets each title.
- On PostgreSQL, requests finishing together all get their "available" message.
- Removing a media server mid-scan doesn't bring its links back.
- Who Watched no longer counts 4K plays twice.
- Music Full Scan doesn't mark albums gone while MusicBrainz is down.
- On PostgreSQL, list and notification times are right again.
- With CSRF Protection on, API keys can make changes; a wrong key is always refused.
- Emails show the logo in Gmail and Outlook.
- Pages scroll again after a dialog closes on a phone.
- A beta release no longer tells stable installs an update is available.
- Settings sections that fail to load say so, with Retry.
- Icon-only buttons have names for screen readers.

## 1.1.0 (13 October 2026)

### New

- **Jellyfin and Emby** get Suggested for You, Who Watched, Pick for the Room, Catch Me Up, "up next" and Match Check.
- **40 languages**, notification titles included.
- **Trakt**: import public lists; your Trakt watchlist is requested for you.
- **Sonarr v5** support.
- **NZBGet, Transmission, Deluge and rTorrent**, for live progress and Backfill.
- **The admin agent can fix what's there**: replace a file, block a release group and more, after you approve.
- **Blocked release groups** (Settings → Backfill).
- **Collections in search.**
- **Your own Networks row.**
- **Watchlist sync for new people** (Settings → Users).

### Changed

- Signing in takes you back to the page you were on.
- Radarr searches straight away only once a film is out by its Minimum Availability.
- Studio and network pages follow your Discover region and language.
- On a phone, tapping a download pill shows the download.
- Import Jellyfin or Emby Users lists only new people.
- Tautulli moved to Settings → Services.
- Real logos for download clients, Bazarr and Tautulli.

### Fixed

- Safer accounts: user managers can't change admins, password changes ask for the current one.
- Blocklisted titles stay out.
- Backfill keeps downloads while a service restarts.
- Shared lists ask before using what you watched.
- A media server not answering no longer marks seasons deleted.
- Fewer repeat notifications; Approve from a notification works.
- Telegram accepts backticks and backslashes.
- Many smaller fixes to the agent, AI Search, jobs, Health and Settings.

## 1.0.0 (11 October 2026)

The first release: AI Search, Backfill and the admin agent, Health, watch lists, the release calendar and live download status.
