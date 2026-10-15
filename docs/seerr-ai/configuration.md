# Configuration reference

[← Seerr AI guide](./README.md)

What Seerr AI adds to Seerr's settings, with defaults. Everything here is admin-only unless it says otherwise.

## Settings pages

| Where | What | Defaults |
|---|---|---|
| **Settings → General** | **Image Cache Size Limit**, with Enable Image Caching: posters and backdrops are also kept as AVIF and WebP at three sizes; the least recently viewed go first past the limit. | 2048 MB (at least 256) |
| **Settings → Media Servers** | Connect, edit and remove Plex, Jellyfin and Emby, choose the primary one, and whether people may sign in with each. See [Plex, Jellyfin and Emby together](./media-servers.md). | The server chosen at setup, as primary |
| **Settings → Users** | **Auto-Import Plex Users**: an account for everyone the Plex server is shared with, hourly. Only adds; someone deleted isn't brought back. | Off |
| **Settings → Users → Single Sign-On** | Providers people can sign in with (Authentik, Authelia, Keycloak, Pocket ID, Google…): name, issuer URL, client ID and secret (never sent back to the browser), button logo, scopes, **Enabled**, **Let New People Sign Up**, **Test**, and the redirect URL to give the provider. Needs the Application URL. See [Single sign-on](./single-sign-on.md). | None; scopes `openid profile email`; enabled; sign-up off |
| **Settings → Features** | Turns optional features off for everyone. See [Feature switches](#feature-switches). | All on |
| **Settings → Services → Download Clients** | SABnzbd, NZBGet, qBittorrent, Transmission, Deluge and rTorrent, read for live progress, and for Backfill to send what it finds to. Keys and passwords are never sent back to the browser. | None |
| **Settings → Services → Bazarr** | Subtitles and transcription. | Port 6767 |
| **Settings → Services → Tautulli** | Watch history from Plex, for Suggested for You, "up next" on lists, Who Watched, Pick for the Room and Catch Me Up. Plex only; moved here from Settings → Plex. Its API key is never sent back to the browser. With Jellyfin or Emby there is nothing to set up: Seerr AI reads watch history from the server itself, with the API key in Settings → Jellyfin/Emby. | Port 8181 |
| **Settings → Services → Trakt** | The Client ID of your own Trakt app, so people can import public Trakt lists and have their public Trakt watchlist requested. Make the app at [developer.trakt.tv/apps](https://developer.trakt.tv/apps) (Trakt asks for a verified GitHub account); nobody signs in to Trakt. Trakt deletes apps unused for 30 days, which regular watchlist syncing prevents. Never sent back to the browser. | |
| **Settings → Services → Maintainerr** | One or more servers. Per server: show Deleting Soon badges, include in the Deleting Soon row, allow Keep for everyone, days Keep adds (0 restarts the rule's grace period), what counts as "soon". | Port 6246; badges, row and Keep on; 0 days; 14 days |
| **Settings → Services → Lidarr** | Music. Address, API key, quality and metadata profiles, root folder and tags for new artists; **Enable Scan** brings in what Lidarr already has; **Tag Requests** tags the artist with who asked. Music appears for everyone once one Lidarr is the default. See [Music](./music.md). | None |
| **Settings → Plex / Jellyfin / Emby → Music Libraries** | The music libraries read to find which albums are here, apart from the film and series ones. With none switched on anywhere, Lidarr's files decide. | Off until switched on |
| **Settings → Metadata → Music** | **MusicBrainz Address** (a mirror of your own has no request limit), **Contact Email** sent to MusicBrainz, **New and Popular Music** from ListenBrainz, **TheAudioDB API Key** for pictures of artists, **Most Albums in One Request**. | Public MusicBrainz; none; on; none; 100 |
| **Settings → Users** | **Global Album Request Limit**: albums each person may request in a period, like seasons for series. Each person's own limit is on their settings. | Unlimited |
| **Settings → Services → Radarr** | **Anime Quality Profile**, **Anime Root Folder**, **Anime Tags** for anime movies. | Unset (anime movies use the regular ones) |
| **Settings → Services → Override Rules** | Sonarr rules can set **Series Type**; Radarr rules can set **Anime**. | Left to detection |
| **Settings → Services → Anime** | **Leave out anime made in**: countries whose anime-styled titles don't count as anime unless they're in Japanese. | Empty (United States on servers from before the setting) |
| **Settings → Services** | **Anime Check** report and **Run Check**. | |
| **Settings → AI** | Provider, key, model, per-feature models (Advanced), **Daily Limit per Person**, credit. See [AI](./ai.md). | Off; 20 answers a day |
| **Settings → Backfill** | Prowlarr, download clients, category, when a title is stuck, approval, the admin agent; limits under Advanced. See [Backfill](./backfill-and-agent.md). | Off; see below |
| **Settings → Notifications** | New types: **List Activity**, **Plex Reauth** (always sent), **Backfill** and **Health** (admins). | Web push on for all four |
| **Settings → Health** | Checks, Search all, resources. See [Keeping it healthy](./health.md). | |
| **Settings → How It Works** | The admin overview. | |

### Backfill defaults

| Setting | Default |
|---|---|
| Enabled | Off |
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
| Health Alerts | every 10 minutes | Tells admins when a connected service newly has a problem. |
| Anime Check | daily, 04:15 | Report: series and movies in the wrong anime folder, type or profile. |
| Match Check | daily, 04:20 | Report: folders a connected media server (Plex, Jellyfin or Emby) matched to another title. |
| Music Sync | every 5 minutes (at :03, :08…) | Reads what each server's music libraries added recently, follows Lidarr's work on requests (counting its files, adding albums it didn't have yet), completes requests whose albums are all here, and says so. Also runs a minute after Lidarr imports something. Only while music is set up and on. |
| Music Full Scan | daily, 03:40 | Reads every music library and all of Lidarr; with **Enable Scan** on, brings in what Lidarr has; marks albums gone from everywhere as deleted (or not here, if nobody asked for them), unless a server or Lidarr didn't answer. Only while music is set up and on. |
| Database Maintenance | daily, 03:45 | Clears rows nothing reads any more (and MusicBrainz answers nobody has looked at in a month), then compacts the database. |

## Feature switches

Every feature below is on unless an admin turns it off for everyone (**Settings → Features**) or a person turns it off for themselves (**Profile → Settings → Features**). Off for everyone wins, and the server enforces it, not only the buttons.

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
| `music` | Music: the Music item, music in search and on Discover, requesting music, and the Lidarr and music settings. Only appears once a Lidarr is added |
| `aiChat` | AI Search |
| `aiReasons` | Why These Suggestions |
| `aiPicker` | Pick for the Room |
| `aiRecap` | Catch Me Up |
| `aiDeletionReview` | Review Deletions (request managers) |
| `aiIssueTriage` | Suggest Issue Fixes (issue managers) |
| `aiLogs` | Explain Logs (admins) |
| `aiBackfill` | Backfill Second Opinion (admins) |
| `aiAgent` | The admin agent (admins) |

The AI switches only appear once AI is set up.

## Per-person settings

| Where | What |
|---|---|
| Profile → Settings → Features | Turn features off for yourself, music included |
| Profile → Settings → Passkeys | Add, rename and remove passkeys |
| Profile → Settings → Linked Accounts | Link or remove single sign-on providers, beside media server accounts |
| Profile → Settings → General → Trakt Username | Your public Trakt watchlist is requested for you, with **Auto-Request Movies** and **Auto-Request Series** (once an admin has set up Trakt) |
| Discover → pencil button | Rows to show on your home page |
| Profile → Settings → Notifications → Web Push | Which notifications reach your devices |

## API

Everything Seerr AI adds is in [seerr-api.yml](../../seerr-api.yml) and at `/api-docs` on a running install.
