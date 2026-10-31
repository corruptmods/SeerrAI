# Configuration reference

[← Seerr AI guide](./README.md)

What Seerr AI adds to Seerr's settings, with defaults. Everything here is admin-only unless it says otherwise.

## Settings pages

| Where | What | Defaults |
|---|---|---|
| **Settings → General** | **Image Cache Size Limit**, with **Enable Image Caching**: posters, backdrops and music artwork from outside are kept in the config folder, also as AVIF and WebP at three sizes (these count towards the limit); the least recently viewed go first past it. | 2048 MB (at least 256) |
| **Settings → Appearance** | The look of everyone who hasn't chosen their own, and of the sign-in page: **Mode** (Dark, Light, Match the person's device), **Accent colour** (Custom takes any colour), **Dark background** (Classic, True black, Slate, Warm). Everyone can still choose their own. **Seasonal themes**: which seasons run, and when. See [Themes](./themes.md). | Dark, Indigo, Classic (as before themes); Halloween, Holidays and New Year on, Lunar New Year off |
| **Settings → Appearance → Theme file** | A [theme file](./themes.md#theme-files) as the default look, for everyone who hasn't chosen their own and the sign-in page. | None |
| **Settings → Appearance → Server CSS** | Styles for everyone, the sign-in page included; may `@import` a stylesheet from elsewhere, such as theme.park. At most 64 KB. See [Custom CSS](./themes.md#custom-css). | Empty |
| **Settings → Appearance → Let people add their own CSS** | Shows **Personal CSS** in everyone's Appearance settings; theirs only changes their own screens. | Off |
| **Settings → Media Servers** | Connect, edit and remove Plex, Jellyfin and Emby, choose the primary one, and whether people may sign in with each. See [Plex, Jellyfin and Emby together](./media-servers.md). | The server chosen at setup, as primary |
| **Settings → Network** | **Enable Proxy Support** trusts proxies on this machine, your network and Tailscale; **Trust Cloudflare** and **Also Trust These Proxies** add public ones. See [Network](../using-seerr/settings/network.md#enable-proxy-support). | Off; off; none |
| **Settings → Users** | **Auto-Import Plex Users**: an account for everyone the Plex server is shared with, hourly. Only adds; existing accounts are left as they are, and someone deleted isn't brought back. **Watchlist sync for new people**: new accounts start with their Plex or Trakt watchlist requested, for movies, series or both; existing people keep their own choice, and anyone can change theirs in their profile. | Off; off |
| **Settings → Users → Let People Make Their Own API Keys** | Personal API keys for apps and scripts, each acting as the person who made it with exactly their permissions. **Who Can Make Them**: admins and people who can manage users, or everyone. Turning it off stops every personal key until it's turned back on. See [API](#api). | Off; admins and user managers once on |
| **Settings → Users → Single Sign-On** | Providers people can sign in with (Authentik, Authelia, Keycloak, Pocket ID, Google…): name, issuer URL, client ID and secret (never sent back to the browser), button logo, scopes, **Enabled**, **Let New People Sign Up**, **Who Can Sign In** (rules on the provider's claims, such as a group), **Test**, and the redirect URL to give the provider. Needs the Application URL. See [Single sign-on](./single-sign-on.md). | None; scopes `openid profile email`; enabled; sign-up off; no rules (anyone with an account at the provider) |
| **Settings → Features** | Turns optional features off for everyone. See [Feature switches](#feature-switches). | All on |
| **Settings → Features → Siri Shortcut** | The iCloud link to the "Fix this show" shortcut, offered on everyone's Siri page. See [Reporting with Siri](./siri.md#making-the-shortcut-admins). | Empty |
| **Settings → Services → Download Clients** | SABnzbd, NZBGet, qBittorrent, Transmission, Deluge and rTorrent, read for live progress, and for Backfill to send what it finds to. Keys and passwords are never sent back to the browser. | None |
| **Settings → Services → Prowlarr** | Searched directly by Backfill and for songs taken from albums; neither runs without it. Tested before it is saved. Its API key is never sent back to the browser. | None |
| **Settings → Services → Bazarr** | Subtitles and transcription. | Port 6767 |
| **Settings → Services → Tautulli** | Watch history from Plex, for Suggested for You, "up next" on lists, Who Watched, Pick for the Room and Catch Me Up. Plex only; Jellyfin and Emby need nothing. Its API key is never sent back to the browser. | Port 8181 |
| **Settings → Services → Trakt** | The Client ID of your own Trakt app, so people can import public Trakt lists and have their public Trakt watchlist requested. Make the app at [developer.trakt.tv/apps](https://developer.trakt.tv/apps) (Trakt asks for a verified GitHub account); nobody signs in to Trakt. Trakt deletes apps unused for 30 days, which regular watchlist syncing prevents. Never sent back to the browser. | |
| **Settings → Services → Maintainerr** | One or more servers (Maintainerr needs no API key). Per server: show Deleting Soon badges, include in the Deleting Soon row, allow Keep for everyone signed in (the button sits where Request would), days Keep adds (0 restarts the rule's grace period), what counts as "soon". | Port 6246; badges, row and Keep on; 0 days; 14 days |
| **Settings → Music** | The **Music** switch for everyone. **Include Music in All Search Results**. **Where Music Comes From**: **MusicBrainz Address**, **Contact Email**, **New and Popular Music** (ListenBrainz and Apple Music's charts), **TheAudioDB API Key**, **Most Albums in One Request**. Links to music's other settings. See [Music](./music.md#setting-it-up-admins). | On; on once Lidarr is set up; public MusicBrainz; none; on; none; 100 |
| **Settings → Services → Lidarr** | Music. Address, API key, quality and metadata profiles, root folder and tags for new artists; **Enable Scan** brings in what Lidarr already has; **Tag Requests** tags the artist with who asked. Music appears for everyone once one Lidarr is the default. See [Music](./music.md). | None |
| **Settings → Media Servers → Edit → Music Libraries** | The music libraries read to find which albums are here. With none on anywhere, Lidarr's files decide. | Off until switched on |
| **Settings → Users** | **Global Album Request Limit**: albums each person may request in a period, like seasons for series. Each person's own limit is on their settings. | Unlimited |
| **Settings → Services → Radarr** | **Anime Quality Profile**, **Anime Root Folder**, **Anime Tags** for anime movies. | Unset (anime movies use the regular ones) |
| **Settings → Services → Override Rules** | **Age Ratings** to match on; Sonarr rules can set **Series Type**, Radarr rules **Anime**. | None; left to detection |
| **Settings → Services → Anime** | **Leave out anime made in**: countries whose anime-styled titles don't count as anime unless they're in Japanese. | Empty (United States on servers from before the setting) |
| **Settings → Services** | **Anime Check** report and **Run Check**. | |
| **Settings → Quality** | Quality profiles Seerr AI creates in Radarr and Sonarr, per server: presets from Seerr AI or TRaSH Guides, adjustments, band step; **Fill gaps with Seerr AI** and **Apply updates automatically** for TRaSH Guides. Nothing is sent to a server until it is managed and applied. See [Quality profiles](./quality.md). | Every server Not managed; Fill gaps on; Apply updates automatically off; usenet at equal quality, torrents wait 2 hours when chosen, band step 100 |
| **Settings → AI** | Provider, key, model, per-feature models (Advanced), **Daily Limit per Person**, credit. See [AI](./ai.md). | Off; 20 answers a day |
| **Settings → Backfill** | Download clients, category, when a title is stuck, approval, the admin agent; limits under Advanced. See [Backfill](./backfill-and-agent.md). **Download Check** (Off, Report only or On) is saved on its own and needs nothing else here; see [Download Check](./download-check.md). | Off; see below |
| **Settings → Notifications** | New types: **Plex Reauth** (always sent), **Backfill**, **Health** and **Wrong Match** (admins), and **List Activity** (each person's own settings, never a channel's). | Web push on; Wrong Match on wherever Health was |
| **Settings → Health** | Checks, Search all, resources, and **Check new requests as they're imported** (under Titles → Folders matched to another title). See [Keeping it healthy](./health.md). | On |
| **Settings → How It Works** | The admin overview. | |

### Backfill defaults

| Setting | Default |
|---|---|
| Enabled | Off |
| Download Check | Off |
| Movies too | On |
| Stuck after (since Sonarr's or Radarr's last search) | 24 hours |
| Treat files below the cutoff as gaps | Off |
| Category | `backfill` |
| Approve some packs automatically | Off (minimum score 700, largest 25 GB) |
| Replace failed downloads | On |
| *Advanced:* titles searched per scan | 5 |
| *Advanced:* days before searching a title again | 7 |
| *Advanced:* include specials | Off |
| *Advanced:* downloads at once, per client | 2 |
| *Advanced:* keep free on the disk | 200 GB |
| *Advanced:* give up on a torrent with no progress | 12 hours (0 never) |
| *Advanced:* days to keep finished downloads | 90 (0 forever) |
| Admin agent steps in on its own | On |
| *Advanced:* agent runs a day on its own / downloads a day / largest download | 12 / 10 / 40 GB |
| *Advanced:* agent steps per go / times it carries on by itself | 30 / 3 |
| *Advanced:* days to keep finished agent conversations | 30 (0 forever) |
| Step down a quality preset (titles on Seerr AI's presets) | Off (30 days) |

## Plex, Jellyfin and Emby

Seerr AI works with all three, as Seerr does, and with more than one at once (see [Plex, Jellyfin and Emby together](./media-servers.md)). Its own features work with all three too, with a few exceptions:

| Feature | Plex | Jellyfin and Emby |
|---|---|---|
| Suggested for You, Who Watched, Pick for the Room, Catch Me Up, "up next" and watch sync on lists, AI Search knowing what you watched | Needs Tautulli | Read from the server itself; nothing to set up |
| Match Check (wrong matches on Health and title pages) | Yes, fixed with **Fix Match** | Yes, fixed with **Identify** |
| Health: the media server answering, and its version | Yes | Yes |
| Passkeys | Refused once the server owner stops sharing with the account (and no other linked account still lets them in) | Refused once the account is deleted or switched off on the server (likewise) |
| Your default subtitle on the Subtitles card | Yes | No: Jellyfin and Emby choose subtitles by language preference rather than per title |
| Plex watchlist sync, Plex user import, expired Plex sign-ins on Health | Yes | Not applicable |
| Trakt watchlist sync and Trakt list import | Yes | Yes |

Jellyfin and Emby keep the latest play of each film or episode rather than a log of every play, so a rewatch moves a title forward instead of adding another play.

## Jobs

Seerr AI adds these to **Settings → Jobs & Cache**, where each can be rescheduled or run now. Times are the server's.

| Job | Default | What it does |
|---|---|---|
| Notification Reconcile | every 2 minutes | Sends notifications that were missed, once each. |
| Episode Sync | every 5 minutes | Reads which episodes Sonarr has, for per-episode availability. |
| Future Season Requests | every 6 hours | Requests new seasons for series people follow. |
| Plex User Import | hourly | With Auto-Import Plex Users on. Plex only. |
| Backfill Scan | every 6 hours | Finds stuck titles and searches a few. Only with Backfill on. |
| Backfill Downloads | every minute | Moves approved Backfill downloads along: picks files, imports, cleans up. |
| Download Check | every 30 seconds | Checks what Sonarr and Radarr grabbed, and imports that got stuck. Only with Download Check on or on Report only. |
| Health Alerts | every 10 minutes | Tells admins when a connected service newly has a problem. |
| Anime Check | daily, 04:15 | Report: series and movies in the wrong anime folder, type or profile. |
| Quality Profiles Check | hourly, at :20 | For servers in Settings → Quality: checks TRaSH Guides for changes once every 24 hours if a preset uses it, notes changes made in Radarr or Sonarr (shown on Health), applies TRaSH Guides updates only with **Apply updates automatically** on, and every 6 hours steps titles down or back. Only does anything for managed servers. |
| Match Check | daily, 04:20 | Report: folders a connected media server (Plex, Jellyfin or Emby) matched to another title. |
| Music Sync | every 5 minutes (at :03, :08…) | Reads what each server's music libraries added recently, follows Lidarr's work on requests (counting its files, adding albums it didn't have yet), completes requests whose albums are all here, and says so. Also runs a minute after Lidarr imports something. Only while music is set up and on. |
| Music Full Scan | daily, 03:40 | Reads every music library and all of Lidarr; with **Enable Scan** on, brings in what Lidarr has; marks albums gone from everywhere as deleted (or not here, if nobody asked for them), unless a server, Lidarr or MusicBrainz didn't answer. Only while music is set up and on. |
| Database Maintenance | daily, 03:45 | Clears rows nothing reads any more (and MusicBrainz answers nobody has looked at in a month), then compacts the database. |

## Feature switches

Every feature below is on unless an admin turns it off for everyone (**Settings → Features**, or **Settings → Music** for music) or a person turns it off for themselves (**Profile → Settings → Features**). Off for everyone wins, and the server enforces it, not only the buttons.

| Switch | What it turns off |
|---|---|
| `suggestedForYou` | The Suggested for You row and page |
| `deletingSoon` | The Deleting Soon row, "Deleting in N days" badges and Keep |
| `releaseCalendar` | The Calendar page |
| `arrivalEstimates` | "When it should arrive" on requests and title pages |
| `whoWatched` | Who has watched a title, on its page (admins) |
| `newSeasons` | Getting new seasons as they premiere (off pauses the follows) |
| `watchSuggestions` | "Finished watching?" on lists |
| `passkeyPrompt` | The banner offering to add a passkey (passkeys still work) |
| `subtitles` | The Subtitles panel and episode subtitle tags |
| `autoFix` | Fixing reported problems automatically |
| `siri` | Reporting with Siri, the Siri page and Siri keys. See [Reporting with Siri](./siri.md) |
| `music` | Music: the Music item, music in search and on Discover, requesting music, and the Lidarr and music settings. Switched for everyone under Settings → Music, which is there before a Lidarr is added |
| `aiChat` | AI Search |
| `aiReasons` | Why These Suggestions |
| `aiPicker` | Pick for the Room |
| `aiRecap` | Catch Me Up |
| `aiDeletionReview` | Review Deletions (request managers) |
| `aiIssueTriage` | Suggest Issue Fixes (issue managers) |
| `aiReports` | Understand Reports |
| `aiLogs` | Explain Logs (admins) |
| `aiBackfill` | Backfill Second Opinion (admins) |
| `aiAgent` | The admin agent (admins) |

The AI switches only appear once AI is set up.

## Per-person settings

| Where | What |
|---|---|
| Profile → Settings → Features | Turn features off for yourself, music included |
| Profile → Settings → Appearance | Your own look: mode, accent colour, dark background, seasonal themes and extras (spacing, corners, blur behind title pages, which is off unless chosen, and see-through panels), or the server's. See [Themes](./themes.md) |
| Profile → Settings → Appearance → Themes | Built-in looks (Seerr Classic, Midnight, Daylight, Ember), **Import a Theme** and **Export My Theme**. See [Theme files](./themes.md#theme-files) |
| Profile → Settings → Appearance → Personal CSS | Your own styles, when an admin allows it. See [Custom CSS](./themes.md#custom-css) |
| Profile → Settings → Passkeys | Add, rename and remove passkeys |
| Profile → Settings → API Keys | Make and revoke your own API keys, when an admin allows it. See [Your account](./account.md#api-keys) |
| Profile → Settings → Linked Accounts | Link or remove single sign-on providers, beside media server accounts |
| Profile → Settings → General → Trakt Username | Your public Trakt watchlist is requested for you, with **Auto-Request Movies** and **Auto-Request Series** (once an admin has set up Trakt) |
| Discover → pencil button | Rows to show on your home page |
| Profile → Settings → Notifications → Web Push | Which notifications reach your devices |

## API

Everything Seerr AI adds is in [seerr-api.yml](../../seerr-api.yml) and at `/api-docs` on a running install.

### Keys

Every request with an `X-Api-Key` header uses one of two kinds of key:

- **The server's key** (Settings → General) acts as the owner, or as anyone you name in `X-API-User`. It's for tools you run as the admin, like the *arr apps, and works as it always has.
- **Personal keys** start with `sai_` and act only as the person who made them, with exactly their permissions; `X-API-User` is refused with one. They're for an app or script someone uses for themselves.

Both work with **CSRF Protection** on (Settings → Network): a request with an `X-Api-Key` header needs no CSRF token and never uses a session cookie sent with it, so a wrong key gets a 401 even from a signed-in browser. Keys are only read from that header, never from the address.

Personal keys are off until you turn on **Let People Make Their Own API Keys** in Settings → Users, and choose **Who Can Make Them**: admins and people who can manage users (the choice it starts with), or everyone. Start with the narrower one: a key is as good as that person's password to whoever holds it, so open it to everyone only when people actually want it.

How they're kept safe:

- Only a hash of each key is stored. A key is shown once, when it's made, and never again, to anyone.
- Each key has a name, and expires after 30 days, 90 days, a year, or never. Up to 10 per person.
- A key stops working when it expires or is revoked, while personal keys are off, when its owner is no longer allowed them, and when its owner could no longer sign in (checked every few minutes against Plex, Jellyfin or Emby). Deleting a person deletes their keys.
- A personal key can't make more keys: making one needs a signed-in session.
- A refused key gets a 401 with a plain message, such as "This API key expired on 2026-12-01". Wrong keys count toward the same limit as wrong passwords (10 in 15 minutes from one address, then a 429 with `Retry-After`). Someone guessing doesn't hold up the real keys used from the same address, and an expired key an old app keeps sending doesn't count.
- Keys made, revoked and refused are logged with their id and name (label `API Key`), never the key itself.
- "Last used" is updated at most once a minute.
- Admins who manage users see anyone's keys on their **API Keys** page (except the owner's and other admins', as with passkeys) and can revoke them.
