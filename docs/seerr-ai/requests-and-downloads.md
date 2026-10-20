# Requests and downloads

[← Seerr AI guide](./README.md)

## The path of a request

1. Someone requests a title. If they can't auto-approve, it waits for a request manager, who can also change which server, profile and folder it goes to before approving.
2. Approved, it goes to Radarr (films), Sonarr (series) or Lidarr (music), which search and send it to the download client.
3. When it's downloaded, they import it, renamed their way, into the library folder.
4. The media server lists it, and Seerr AI marks it available.
5. Whoever asked is told, by web push or whatever they've turned on.

If Sonarr or Radarr can't find it, [Backfill](./backfill-and-agent.md) and the admin agent look further.

## When will it arrive?

Requests and title pages say when a title should arrive, in one line:

- **Not out yet:** "Digital release expected 3 Nov", "In cinemas", "Next requested episode airs…".
- **Out, not found yet:** "Released digitally — searching", and with enough history, "Usually arrives within N days here" (from at least five finished requests, leaving out any over 14 days).
- **Downloading:** the time left, or why there isn't one: stalled, waiting its turn, held by a delay profile, finishing up, being added to the library, waiting on an admin, or failed and looking for another.

If it can't tell, it says nothing. Dates use your Discover region, then the server's. You see estimates for your own requests; people who can view or manage requests see everyone's. Approval notifications carry an "Expected" line. Switch: `arrivalEstimates`.

## What the status pills mean

| Pill | What is happening |
|---|---|
| **Pending** | Waiting for approval. |
| **Requested** | Approved and with Radarr, Sonarr or Lidarr; nothing downloading yet. |
| **Waiting** | A release was found and is held for the delay profile. The tooltip says when it goes. |
| **Queued** / **Paused** | In the download client, waiting or paused. |
| **Downloading 42%** | Downloading. |
| **Stalled** | A torrent with nobody to download from. |
| **Finishing up** | Being verified, repaired, unpacked or moved. |
| **Importing** | Being added to the library folder. |
| **Adding to Plex** | In the folder; Plex (or Jellyfin, Emby) hasn't listed it yet. Usually a minute or two. "Waiting for Plex to match it" means it may have been filed under another title. |
| **Needs attention** | Held up in Radarr or Sonarr, usually an import they won't make alone. |
| **Download failed** | Looking for another release. |
| **Failed** | The request couldn't be sent. See [Failed requests](#failed-requests). |
| **Partially Available** / **Available** | Some or all of it is in the library. |

For a series the pill names what's downloading: **S1E3**, **S1** (a season pack), **S1E3–E5**, **S1–S3**. The tooltip lists each download.

About a minute after an import, Seerr AI asks the media server what it added, and keeps asking for a few minutes, so a title turns Available within a minute or two. Pages refresh every 5 seconds while downloading and every 30 seconds while requested.

### Live progress from the download client

Admins can add SABnzbd, NZBGet, qBittorrent, Transmission, Deluge and rTorrent in **Settings → Services → Download Clients**. Progress then updates every few seconds, with the client's own steps (checking, repairing, unpacking, no peers and so on). Seerr AI only reads from them.

## Who asked, and why it was declined

- **Requested by**: a film's or series' page lists its requests among its details: who asked, when, 4K or not, which seasons, and where each stands.
- **Declining**: whoever declines can add a **Reason** (optional), such as "Already on Netflix". The person who asked sees it on their request, on the title's page and in the "declined" notification. Others see it only if they can view all requests. Webhooks get it as `{{decline_reason}}`. Declining from a phone notification's button gives no reason.

## Failed requests

A request is marked **Failed**, with the reason on its card, when Radarr, Sonarr or Lidarr wouldn't take it, or when its server is gone: "Its Radarr server was removed", or no server of its kind is the default. Whoever asked is told once.

Request managers can fix it from the card in **Requests**, or from the title's **Manage** panel:

- **Retry** sends it again, to the default server of its kind (4K or not), with that server's profile, folder and tags.
- **Edit** opens the request window: choose another server, profile, folder, seasons or albums, then **Save and Retry**.

If there's no default server, Retry says so: add one in **Settings → Services**, or use Edit. Servers that run without Radarr, Sonarr or Lidarr and fill requests by hand are unaffected: approved requests stay approved.

## Series: single episodes and new seasons

- **One season or one episode:** each season has **Request Season**, and each episode **Request**. In the request window, open a season to pick episodes. Sonarr monitors everything any request asked for.
- **Which episodes are here:** each episode shows whether it's in the library (from Sonarr every five minutes).
- **New seasons as they premiere:** **Get New Seasons** on a series page, or **Also get new seasons as they premiere** in the request window. Each new season is requested within a day of airing, as a normal request. It ends by itself when a finished series has nothing left. Switch: `newSeasons`.

## Anime

Seerr AI decides what counts as anime the same way everywhere (requests, scans, title pages, the Anime page and the Anime Check): anything TMDB tags as anime, from any country, and animation in Japanese.

- **Leave out anime made in** (**Settings → Services → Anime**): countries whose anime-styled titles don't count unless in Japanese. List the United States to keep Avatar: The Last Airbender and Castlevania with your regular series; leave it empty to count anime from everywhere. Servers from before this setting start with the United States listed.
- **When requesting:** **Request as anime** is ticked for anime, from Japan or anywhere else. Untick it when it's wrong, and the request goes to the regular folder, profile and tags.
- **On a title:** admins set **Anime** in the Manage panel to Automatic, Anime or Not anime. **Save and Move** sets the matching root folder (the files move), quality profile and, for a series, series type.
- **Movies:** each Radarr can have its own anime root folder, quality profile and tags (Settings → Services).
- **Anime Check** (nightly, 04:15): a report on Settings → Services of series in the wrong root folder or with the wrong series type, and movies in the wrong root folder or quality profile. It changes nothing; **Run Check** runs it now.

## Override rules

Override rules (**Settings → Services**) send matching requests to another folder, profile or tags. Seerr AI adds:

- **Age Ratings**: match titles by rating, such as G and PG, or TV-Y and TV-Y7, to send kids' titles to their own folder. Ratings are TMDB's for your Discover Region (Settings → General), or the US rating when there's none there.
- **Series Type** (Sonarr) and **Anime** (Radarr).
- A rule on TMDB's anime keyword matches what Seerr AI counts as anime, not the keyword itself.

## Blocklisting

People who can manage the blocklist can blocklist a title nobody has requested, with an optional reason (up to 500 characters). For a title already requested or downloaded, only admins can, with **Blocklist and delete files**: it removes the title and its files from Radarr or Sonarr, adds an import exclusion and declines open requests. That can't be undone.

## Other additions

- **History:** a title's Manage panel lists everything that happened to it, including what Backfill and the admin agent did. It survives the title being deleted. For request managers and admins.
- **Who watched:** admins see who watched a title, and how far (Plex needs Tautulli). Switch: `whoWatched`.
- **Collections:** a collection page says how much you have and offers **Request the missing N**.
- **Notify me when available:** for a title someone else requested.
- **Requests page:** filter by several statuses, types and people at once.
- **Also add to a list:** the request window can put the title on one of your watch lists.
