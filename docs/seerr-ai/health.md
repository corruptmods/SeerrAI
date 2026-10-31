# Keeping it healthy

[← Seerr AI guide](./README.md)

## The Health page

**Settings → Health** (admins) checks everything Seerr AI depends on and lists what has quietly gone wrong, each with a link to fix it.

- **Services**: whether each connected service answers (media servers with their version, Radarr, Sonarr, Lidarr, Prowlarr, download clients, Bazarr, the AI provider, Tautulli, Maintainerr, the PostgreSQL pool), plus their own warnings: low disks, paused indexers or subtitle providers, an AI account out of credit. The download client Backfill uses also lists what it's missing (Deluge's Label plugin, rTorrent commands, Transmission 3.0+, NZBGet 16+).
- **Backfill**: titles it couldn't search, packs waiting for approval, downloads that failed this week, Download Check findings and admin agent conversations waiting for you, and what Download Check and the agent did this week.
- **Requests**: failed, approved but never sent, waiting on approval for over a week, and requests no longer linked to a title (with a button to remove them).
- **Titles**: processing for over a week (with **Search now** for each and **Search all**, which searches a season missing entirely as one), series requests with no TVDB id, folders a server matched to the wrong title, collections partly in the library.
- **Music** (once Lidarr is added): albums no server lists after a day, requested albums with no release after a week (with **Search now**), and whether MusicBrainz is answering. See [Music](./music.md#keeping-track).
- **Users**: expired Plex sign-ins.
- **Resources**: Seerr AI's own CPU and memory over the last hour or day.

### Health alerts

Every 10 minutes (the **Health Alerts** job) the service checks run, and admins get a **Health** notification when something newly goes wrong: a service down, an indexer or provider paused, a disk filling up. A problem is reported once it has been seen twice in a row (a moment's timeout isn't), once only, and again only if it clears and comes back. It arrives by web push, and on any notification service with **Health** ticked.

## Match Check: titles matched wrongly

Media servers match files to titles by name; Sonarr, Radarr and Lidarr by id. When they disagree, the wrong title shows as available and the right one shows nothing. A new show called "Wrenna" might be matched to "The Wrenna Diaries".

**Every night** (04:20, the **Match Check** job), Seerr AI reads each library on each connected server, finds each item's folder in Sonarr or Radarr, and compares ids. Problems are listed on Health, and the title's page tells admins what the server matched it to and how to fix it: **Fix Match** in Plex, or **Identify** in Jellyfin and Emby (open the title there), with the id to enter. Until it's fixed, episodes and subtitles can be wrong too. The next check, nightly or after an import, clears it once they agree. **Run now** in Settings → Jobs & Cache runs it straight away.

**As requests arrive**, too: a few minutes after Radarr, Sonarr or Lidarr imports a requested film, episodes or album, Seerr AI checks each server's match the same way.

- **When:** about 2, 7, 22, 52 and 112 minutes after the import, then it stops. A wrong title is reported at once; "not matched" only after about two hours.
- **Who hears:** admins, by the **Wrong Match** notification (on wherever **Health** was), on web push, email, Discord or any service with it ticked. The requester isn't told; their request shows "Waiting for Plex to match it".
- **No floods:** each problem is told once, and not at all if the nightly check already listed it. Problems within 10 minutes go out together, at most 5 messages a day; the rest wait on Health. Fixed problems clear quietly.
- **Music** is compared by MusicBrainz ids, or by artist, title and year, and only reported when clearly different.

To see them, open **Settings → Health** and, under **Titles**, **Folders matched to another title**. It lists **Recent requests** (newest first) and the **Nightly check**, and has the switch **Check new requests as they're imported**.

### Fixing them from here (Plex)

- **Fix matches from here** (on to start): each film or series on Plex that Seerr AI can put right gets a **Fix match** button. It looks the title up in Plex's Fix Match by the id Radarr or Sonarr has (`tmdb-846213`, then the IMDb id), never by name, matches it, and reads Plex back. If Plex then has it as another title, the old match is put back. It doesn't offer to fix music, Jellyfin or Emby, or a film whose file is far off the film's length (replace that one in Radarr instead).
- **Fix automatically** (off to start): new problems are fixed as they're found, and up to 20 from the nightly check each night, without asking. Admins still get the Wrong Match notification, saying it was fixed. One that didn't work isn't tried again for a week.
- **Fixed lately** lists the last fixes, by whom or "By itself", each with **Undo**, which puts the item back as Plex had it.

It uses the calls Plex Web's own Fix Match makes, with the server owner's sign-in. Plex keeps watch history with the match, so fixing a title that was already watched may show it unwatched.

What a row can say:

| It says | Meaning | Fix |
|---|---|---|
| Plex matched "Border Feud (2024)" to Guerra Fronteriza (2024) | The server picked another title. | **Fix Match** (Plex) or **Identify** (Jellyfin, Emby) with the id shown, such as `tmdb-846213`. |
| …to a different film named Quillmore (2025) | Two titles share a name and year. | The same. |
| Plex and Radarr use different entries for… | Same title, but different TMDB or TVDB entries, usually because one was replaced. | Fix the match with the id shown; if nothing is found, Radarr's entry may be outdated. |
| Plex has not matched "…" | No match for the folder. | Fix the match. |
| A length far off the film's (`file 21 min, film 107 min`) | The file is probably another film. | Replace it in Radarr rather than fixing the match. |

A file not named after the film gets a hint to rename it in Radarr, since that's what the server matched on. Items with no folder or no id can't be compared; they're counted apart.

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
