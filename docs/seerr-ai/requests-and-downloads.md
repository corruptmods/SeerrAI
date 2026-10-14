# Requests and downloads

[← Seerr AI guide](./README.md)

## When will it arrive?

Requests and title pages say when a title should arrive, in one line:

- **Not out yet:** "Digital release expected 3 Nov", "In cinemas", "Physical release…", or "Next requested episode airs…".
- **Out, not found yet:** "Released digitally — searching", and once the server has enough history, "Usually arrives within N days here" (worked out from at least five finished requests, leaving out ones that took over 14 days).
- **Downloading:** the time left, or why there isn't one: stalled, waiting its turn, held by a delay profile, finishing up, being added to the library, held up and waiting on an admin, or failed and looking for another.

If it can't tell, it says nothing. Dates use your Discover region, then the server's.

You see estimates for your own requests. People who can view or manage requests see them for everyone's. Approval notifications carry an "Expected" line too.

Switch: `arrivalEstimates`.

## What the status pills mean

| Pill | What is happening |
|---|---|
| **Pending** | Waiting for an admin to approve it. |
| **Requested** | Approved and with Radarr or Sonarr, but nothing is downloading yet. |
| **Waiting** | Radarr or Sonarr found a release and are holding it for their delay profile, in case a better one turns up. The tooltip says when it will be sent. |
| **Queued** / **Paused** | In the download client, waiting its turn, or paused there. |
| **Downloading 42%** | Downloading. |
| **Stalled** | A torrent with no one to download from right now. |
| **Finishing up** | Downloaded; being verified, repaired, unpacked or moved. |
| **Importing** | Radarr or Sonarr are adding it to the library folder. |
| **Adding to Plex** | In the library folder; Plex (or Jellyfin, Emby) hasn't listed it yet. Usually a minute or two, and shown for at most 30 minutes. |
| **Needs attention** | Held up in Radarr or Sonarr, usually an import they won't make on their own. |
| **Download failed** | Radarr or Sonarr are looking for another. |
| **Partially Available** / **Available** | Some of it, or all of it, is in the library. |

For a series, the pill names what is downloading: **S1E3** for one episode, **S1** for a season pack, **S1E3–E5** for several episodes, **S1–S3** for several seasons. The tooltip lists each download.

About a minute after Radarr or Sonarr imports something, Seerr AI asks the media server what it has added, and again each minute a few times until it is listed. A title turns Available within a minute or two of arriving, instead of at the next five-minute scan. This applies to Backfill's downloads too.

Pages and request cards check again every 5 seconds while something is downloading, and every 30 seconds while a title is requested or partly here, so a download that starts later shows without reloading.

### Live progress from the download client

An admin can link SABnzbd, NZBGet, qBittorrent, Transmission, Deluge and rTorrent in **Settings → Services → Download Clients**. Seerr AI then shows progress every few seconds, plus the client's own steps (getting details, checking, verifying, repairing, unpacking, moving, running a script, no peers), instead of Radarr's and Sonarr's once-a-minute view. It only reads from the clients; Radarr and Sonarr still send the downloads.

## Series: single episodes and new seasons

- **One season or one episode:** each season on a series page has **Request Season**, and each episode its own **Request**. In the request window, a season can be opened to pick episodes. Sonarr is told to monitor everything any request asked for, so one request never undoes another.
- **Which episodes are here:** each episode shows whether it is in the library. This comes from Sonarr every five minutes (the Episode Sync job).
- **New seasons as they premiere:** **Get New Seasons** on a series page, or **Also get new seasons as they premiere** in the request window, requests each new season within a day of its air date, as an ordinary request (approval, quotas and notifications as usual). Seasons already out aren't included. It ends by itself once a finished series has nothing left to come. Switch: `newSeasons` (off pauses the follows; they aren't deleted).

## Anime

Seerr AI decides what counts as anime the same way everywhere (requests, scans, title pages, the Anime page on Discover and the Anime Check): anything TMDB tags with its anime keyword, from any country, and animation in Japanese.

- **Leave out anime made in** (**Settings → Services → Anime**): countries whose anime-styled titles don't count as anime unless they're in Japanese. List the United States to keep shows like Avatar: The Last Airbender and Castlevania with your regular series. Empty on a new server; a server that ran Seerr AI before this setting starts with the United States, the rule it always had.

- **When requesting:** "Request as anime" in the request window starts from that decision. Changing it switches the advanced options to the anime folder, profile and tags (or back).
- **On a title:** admins can set **Anime** in the title's Manage panel to Automatic, Anime or Not anime. **Save and Move** moves it in Sonarr or Radarr to the matching folder, profile and series type.
- **Override rules** can set a series' Sonarr type (Standard, Daily, Anime), or whether a movie is anime.
- **Movies:** each Radarr server can have its own anime root folder, quality profile and tags (**Settings → Services**). Until they are set, anime movies use the regular ones.
- **Anime Check** (nightly, 04:15): a report on **Settings → Services** of series and movies that sit in the wrong folder, or have the wrong type or profile, for what Seerr says they are. It changes nothing; **Run Check** runs it now.

## Blocklisting

From a title's page, people who can manage the blocklist can blocklist a title nobody has requested, with an optional reason (up to 500 characters) that shows on the blocklist and in the title's history. For a title already requested or downloaded, only admins can, and the button reads **Blocklist and delete files**: it removes the title from Radarr or Sonarr, deletes its files, adds an import exclusion and declines open requests. That can't be undone.

## Other additions

- **History:** a title's Manage panel lists everything that happened to it: requested, approved, declined, failed to send, available, removed, files deleted, blocklisted, kept from deletion, searched, and what Backfill and the admin agent did. It survives the title being deleted. For request managers and admins.
- **Who watched:** admins see who has watched a title, and how far, on its page (with Plex this needs Tautulli; Jellyfin and Emby keep it themselves). Switch: `whoWatched`.
- **Collections:** a collection page says how much of it you have and offers **Request the missing N**.
- **Notify me when available:** for a title someone else requested.
- **Failed sends can be retried:** a request Radarr or Sonarr wouldn't take is marked **Failed** instead of sitting at Processing, and request managers can retry it.
- **Requests page:** filter by several statuses, types and users at once. Sorting by "added" uses when the request was made.
- **Also add to a list:** the request window can put the title on one of your watch lists at the same time.
