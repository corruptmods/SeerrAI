# Keeping it healthy

[← Seerr AI guide](./README.md)

## The Health page

**Settings → Health** (admins) checks everything Seerr AI depends on and lists what has quietly gone wrong, each with a link to fix it.

- **Services**: whether Plex, Radarr, Sonarr, Prowlarr, each download client, Bazarr, the AI provider, Tautulli, each Maintainerr server and the PostgreSQL connection pool answer, plus what they report themselves: Radarr's and Sonarr's own health warnings and disks running low, indexers Prowlarr has paused, subtitle providers Bazarr has paused (WhisperAI included), an AI account out of credit.
- **Backfill**: titles it couldn't search, packs waiting for approval, downloads that failed this week.
- **Requests**: failed, approved but never sent, waiting on approval for over a week, and requests no longer linked to a title (with a button to remove them).
- **Titles**: processing for over a week (with **Search now** for each and **Search all**), series requests with no TVDB id, folders Plex matched to the wrong title, collections partly in the library.
- **Users**: expired Plex sign-ins.
- **Resources**: Seerr AI's own CPU and memory over the last hour or day.

### Health alerts

Every 10 minutes (the **Health Alerts** job) the service checks run, and admins get a **Health** notification when something newly goes wrong: a service down, an indexer or provider paused, a disk filling up. A problem is reported once it has been seen twice in a row (a moment's timeout isn't), once only, and again only if it clears and comes back. It arrives by web push, and on Discord or any other agent with **Health** ticked.

## Plex Match Check

Plex matches files to titles by their names; Sonarr and Radarr by their own ids. When the two disagree, nothing says so, and the wrong title shows as available while the right one shows nothing. For example, a new show called "Carrie" can be matched to "The Carrie Diaries".

Every night (04:20, the **Plex Match Check** job, Plex only), Seerr AI reads each Plex library, finds each item's folder in Sonarr or Radarr, and compares their ids, not their names. Folders matched to another title, or to none, are listed on the Health page with both sides' ids, and the title's page warns admins what Plex matched it to and what to pick. The next check clears it once they agree. To check now, use **Run now** on Settings → Jobs & Cache.

What a row can say:

| It says | What it means | Fix |
|---|---|---|
| Plex matched "Civil War (2024)" to Guerra Civil (2024) | Plex picked another title. | **Fix Match** in Plex, searching the id shown (for example `tmdb-929590`), which finds exactly that title. |
| …to a different film named Americana (2025) | Two titles share the name and year; Plex picked the other one. The ids are what differ. | The same. |
| Plex and Radarr use different entries for… | The same title by its IMDb id, but Plex and Radarr point at different TMDB (or TVDB) entries for it, usually because one was replaced. Seerr marks Plex's entry as in the library, so the request isn't. | **Fix Match** searching the id shown; if Plex finds nothing, Radarr's entry may be the outdated one. |
| Plex has not matched "…" | Plex has no match for the folder. | **Fix Match** in Plex. |

Items it couldn't compare (no folder, or no id on both sides) are counted apart, not called fine.

## Anime Check

A nightly report (04:15) on **Settings → Services** of series and movies in the wrong folder, or with the wrong type or profile, for what Seerr says is anime. It changes nothing. See [Anime](./requests-and-downloads.md#anime).

## When Seerr AI can't be reached

The installed app and the browser show **Can't reach Seerr** with **What happened**, so you know where to look:

| It says | Look at |
|---|---|
| Couldn't connect at all | This device's connection: network, DNS, VPN or browser |
| Nothing answered in time | The server or something on the way to it |
| Cloudflare's error, explained (521, 522, 524…) | Your home connection, the port forward, or the proxy, as the code says |
| The proxy couldn't get an answer (502–504) | The proxy in front of Seerr AI, or Seerr AI itself |

It keeps trying and reloads by itself once it gets through.

## Settings → How It Works

A single page for admins that explains the path of a request, every status pill, what steps in when a title is stuck, subtitles, where to look when something is wrong, and which settings matter.
