# Requests and downloads

[← Seerr AI guide](./README.md)

## The path of a request

1. Someone requests a title. If they can't auto-approve, it waits for a request manager, who can also change which server, profile and folder it goes to before approving.
2. Approved, it goes to Radarr (films), Sonarr (series) or Lidarr (music), which search and send it to the download client.
3. When it's downloaded, they import it, renamed their way, into the library folder.
4. The media server lists it, and Seerr AI marks it available.
5. Whoever asked is told, by web push or whatever they've turned on.

If Sonarr or Radarr can't find it, [Backfill](./backfill-and-agent.md) and the admin agent look further.

## Request limits

Admins set how many films, seasons and albums each person may request in a period (**Settings → Users**, and on each person's settings). Pending and approved requests count; declined ones don't.

**Send Requests Over the Limit to Admins** (Settings → Users, off by default) lets someone past their limit still request instead of being turned away. Such a request:

- waits for an admin, even for someone who is otherwise approved automatically;
- shows **Over Limit** on its card, the request window says it will wait for an admin, and the "pending" notification to admins says it is over the requester's limit;
- counts towards the limit like any request, and stops counting if it's declined. Approving it is the admin's choice.

It applies to films, series (seasons over the limit, and seasons added by editing a request) and music. Watchlist requests, new seasons of followed series, titles requested by adding them to a list, and several requested at once are still turned away at the limit, so they can't pile up.

## Quality profiles and folders

People who may choose advanced request options pick a request's server, quality profile and folder in the request window. They can also save their own **Default Quality Profiles** (**Profile → Settings → General**): one per server, and one for anime where the server has an anime profile. It is picked first in the request window and used for requests made without one, such as from Siri, AI Search or the API. If the server no longer has that profile, or the person can no longer choose profiles, the server's own default is used.

Admins can tie folders to profiles: **Folders by Quality Profile** on each Radarr and Sonarr server (**Settings → Services**, off until you add one). A request with one of those profiles goes to that folder, whether made in the request window or through the API:

- When the request names no folder, the profile's folder is used.
- When someone who doesn't manage requests picks another folder, the profile's folder is used instead, so an app can't send anime to the regular library. In the request window the folder follows the profile and can't be changed.
- Request managers can still pick another folder.
- It wins over an override rule's folder; override rules still decide for profiles without a folder.

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
| **AI searching** | The [admin agent](./backfill-and-agent.md#the-admin-agent) is looking for what's missing. |
| **Failed** | The request couldn't be sent. See [Failed requests](#failed-requests). |
| **Partially Available** / **Available** | Some or all of it is in the library. |

For a series the pill names what's downloading: **S1E3**, **S1** (a season pack), **S1E3–E5**, **S1–S3**. The tooltip lists each download. Clicking a downloading pill opens the title's downloads; on a touchscreen a tap shows its details first. **Play on Plex** (or Jellyfin, Emby) is at the foot of the details.

About a minute after an import, Seerr AI asks the media server what it added, and keeps asking for a few minutes, so a title turns Available within a minute or two. A download that's grabbed and imported between two looks at the queue (a fast Usenet download can take under a minute) is found in Radarr's or Sonarr's history instead, and shows **Adding to Plex** the same way. Pages refresh every 5 seconds while downloading and every 30 seconds while requested.

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
- **Which are on their way:** an episode being downloaded, by Sonarr, Backfill or the admin agent, shows Queued, Downloading with how far along, or Importing in place of Requested, and the season's list updates by itself while any are on their way.
- **New seasons as they're announced:** **Get New Seasons** on a series page, or **Also get new seasons as they're announced** in the request window. Each new season is requested as a normal request as soon as TMDB lists it (a renewal, with or without a date) and Sonarr lists it too, so Sonarr is watching for it and grabs the first episode on the day it airs. Sonarr only watches seasons it knows, which it learns from TheTVDB when it refreshes the series (every 12 hours unless changed); until then the season waits. Whatever happens, a season is requested within a day of its premiere at the latest, including when Sonarr can't be asked. Specials aren't requested. Each season is requested once for you; if someone already asked for it, it isn't asked for again. Over your limit, it's tried again on the next check. A season is announced to you once, even if TMDB takes it down and puts it back. A season that starts is requested even when an earlier one TMDB lists is still waiting for a date or for Sonarr; that earlier one is still requested when it can be.
- **A season requested before Sonarr lists it:** a season TMDB has announced can be requested before TheTVDB (and so Sonarr) has it. The request stays approved and the season shows as on its way; once Sonarr lists it, Seerr AI monitors it and searches for it, even on a series set to monitor no new seasons.
- **What you're told:** with **Followed Series** on in your notification settings, you're told when a new season is announced and requested for you, when a season you follow starts, and when the series ends or is cancelled. Only you are told, never a channel. A finished series requests nothing early, waits for any season it still has dated to start, then tells you it has ended and stops following it by itself. A season TMDB lists for it without a date doesn't count as coming. Once anyone follows a series, the button shows on for everyone, since its new seasons come regardless. Only the follower, or someone who manages requests, can stop it; a manager's tap stops it for everyone, and its tip names who follows. Switch: `newSeasons`.

## Anime

Seerr AI decides what counts as anime the same way everywhere (requests, scans, title pages, the Anime page and the Anime Check): anything TMDB tags as anime, from any country, and animation in Japanese.

- **Leave out anime made in** (**Settings → Services → Anime**): countries whose anime-styled titles don't count unless in Japanese. List the United States to keep Avatar: The Last Airbender and Gravespire with your regular series; leave it empty to count anime from everywhere. Servers from before this setting start with the United States listed.
- **When requesting:** **Request as anime** is ticked for anime, from Japan or anywhere else. Untick it when it's wrong, and the request goes to the regular folder, profile and tags.
- **On a title:** admins set **Anime** in the Manage panel to Automatic, Anime or Not anime. **Save and Move** sets the matching root folder (the files move), quality profile and, for a series, series type.
- **Movies:** each Radarr can have its own anime root folder, quality profile and tags (Settings → Services).
- **Anime Check** (nightly, 04:15): a report on Settings → Services of series in the wrong root folder or with the wrong series type, and movies in the wrong root folder or quality profile. It changes nothing; **Run Check** runs it now.

## Override rules

Override rules (**Settings → Services**) send matching requests to another folder, profile or tags. Seerr AI adds:

- **Age Ratings**: match titles by rating, such as G and PG, or TV-Y and TV-Y7, to send kids' titles to their own folder. Ratings are TMDB's for your Discover Region (Settings → General), or the US rating when there's none there.
- **Production Countries**: match titles made in any of the chosen countries, such as Korea or France, to send them to their own folder or profile. TMDB's production countries are used, and a series' origin country too; a title TMDB gives no country never matches. As with every condition, anime only matches a rule that also names TMDB's anime keyword.
- **Series Type** (Sonarr) and **Anime** (Radarr).
- A rule on TMDB's anime keyword matches what Seerr AI counts as anime, not the keyword itself.

## Blocklisting

People who can manage the blocklist can blocklist a title nobody has requested, with an optional reason (up to 500 characters). For a title already requested or downloaded, only admins can, with **Blocklist and delete files**: it removes the title and its files from Radarr or Sonarr, adds an import exclusion and declines open requests. That can't be undone.

**Blocklisted tags** (Settings → General) blocklist new titles with those TMDB keywords on each run of **Process Blocklisted Tags**. A title already in the library is left alone, a title a tag still matches is kept as it is from run to run, and a title no tag matches any more is let go; if a TMDB lookup fails, nothing is let go that run.

## Other additions

- **History:** a title's Manage panel lists everything that happened to it, including what Backfill and the admin agent did. It survives the title being deleted. For request managers and admins.
- **Who watched:** admins see who watched a title, and how far (Plex needs Tautulli). Switch: `whoWatched`.
- **Collections:** a collection page says how much you have and offers **Request the missing N**.
- **Notify me when available:** for a title someone else requested.
- **Requests page:** filter by several statuses, types and people at once, and search by title: films and series as TMDB finds the words, music by its artist, album or song.
- **Also add to a list:** the request window can put the title on one of your watch lists.
- **Requests for titles removed before** (**Settings → Users → Requests for Removed Titles**, off to start): a title removed from the library before, deleted from the media server (by Maintainerr, say) or its files removed from Seerr AI, can **Wait for an admin** when requested again, even from people who auto-approve, or be **Refused**. **After Being Removed** sets how many times first. Admins and request managers aren't affected, and the admin's notification says how often it was removed.
- **Marking a title available yourself:** a title requested, downloaded another way and then marked available (or found by a scan) completes its pending requests without sending them to Radarr or Sonarr, so it isn't downloaded twice. Request managers can mark titles available as well as admins; **Clear Data** stays with admins.
