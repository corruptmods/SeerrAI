# Backfill and the admin agent

[← Seerr AI guide](./README.md)

Sonarr and Radarr search their indexers and give up quietly when nothing matches their rules: an episode missing from a season, a show listed under another name, a pack they won't take because one file is wrong. Backfill picks up from there. Admins only.

## What Backfill does

1. Every 6 hours (the **Backfill Scan** job) it finds series and movies that Sonarr or Radarr searched for and didn't grab, once their last search is older than **Stuck after** (24 hours by default).
2. It searches Prowlarr itself, under every name the title goes by, a few titles per scan (requested titles first). Missing specials, and episodes the scene numbers another way, are also searched for by their titles.
3. It opens the likeliest packs (reading the torrent or NZB, without downloading it) and asks Sonarr or Radarr how they would import each file and whether it meets the quality profile. A file whose name carries another episode's title than its number is taken as the episode its title is (**By title**), and one Sonarr won't read that way is turned down; a file named only by its title, as specials often are, is placed by it too.
4. It offers the packs that fill what is missing, with a score and a plan for each file, and sends a **Backfill** notification; tap it to review.
5. When a pack is approved, it downloads only the chosen files to its own category, imports them through Sonarr or Radarr, and cleans up. Torrents aren't seeded afterwards.

Approval can be **Missing episodes only** (recommended), or **Missing and upgrades**, which replaces files on disk and asks you to type the title's name to confirm.

### Music

With music set up, Backfill follows albums too: those Lidarr lists as missing (**Music too** in Settings → Backfill turns this off).

- Lidarr doesn't say when it last searched for an album, so an album counts as stuck once its release date, the day its artist was added, and any approved request for it are all older than **Stuck after**, and nothing for it is in Lidarr's queue.
- Prowlarr is searched under "Artist Album" and the album's name, in its audio categories.
- Each file of a release is matched to a track by its title, or by its number when the release has one file per track. Lidarr imports into one edition of an album: the one already on disk, or, for an album with nothing yet, the edition most of the files are from.
- Approval is **Missing tracks only** or **Missing and upgrades**, as for series.
- An album's page shows admins its Backfill box, and the Backfill button there starts a search. **Start search…** lists the albums Lidarr monitors too; type the album or the artist.

### Setting it up

**Settings → Backfill**:

- **Prowlarr**: address and API key.
- **Downloads**: the client for torrent packs (qBittorrent, Transmission, Deluge or rTorrent) and for Usenet packs (SABnzbd or NZBGet), from **Settings → Services → Download Clients**, and the **category** Backfill uses, kept apart so Sonarr, Radarr and Lidarr don't import on their own.
- **When a title is stuck**: hours since the last search, movies too, music too, and whether files below the cutoff count as gaps (packs that fill gaps still show their upgrades either way).
- **Approval**: approve some packs automatically (only ones that fill what is missing and replace nothing on disk, score at least 700 and are at most 25 GB, by default), and **Replace failed downloads** (on by default): when a download fails or stalls, the next good pack is taken, searching again if need be until none is left; anything outside the limits waits for you.
- **Advanced**: titles per scan, days before searching again, specials, downloads at once, space to keep free, when to give up on a stalled torrent (time spent "checking" doesn't count; a stalled one is then replaced or offered like a failed one), how long to keep history (removed by the nightly **Database Maintenance** job, with the packs it came from), and the agent's limits. The defaults suit most servers.

### The Backfill pages

- **Backfill** in the sidebar: what is stuck, packs found, ignored and complete, with a search box. **Scan now**, **Start search…** and **Search All Stuck**.
  - **Start search…** searches one title now; Prowlarr is always searched under the title and the aliases Sonarr or Radarr has, plus any names you add.
  - **Search All Stuck** searches every stuck title once, one query per title to every indexer, with a pause between titles. Titles Sonarr or Radarr searched today are included; ones Backfill searched in the last day aren't. Packs that pass auto-approve start downloading as they're found.
- **A title's Backfill page**: what is missing and why Sonarr or Radarr didn't get it (often their own search passed a release over because it couldn't match its title), each pack found with its file plan, approve or skip, history, Ignore, and **Get it with AI**.
- **Approving a pack**: only the chosen files download; the torrent client skips the rest, and a Usenet job is removed from the client afterwards. **Include the files the AI placed** adds files whose names didn't say which episode they are: the AI matched them and Sonarr agreed; check them under **Show files** first. If the pack was approved, skipped or dropped while the window was open, it says so instead.
- **A download's page**: progress, pause, resume or end. A failed one says what became of it, linked: **Replaced by #66**, **Backfill is searching for another release**, **The admin agent is looking for another release**, **Backfill offered the next pack**, or **Nothing else was found**. The title's list of downloads says the same under each failed one.
- **On a title's own page**, admins see a Backfill box with what is missing, packs waiting and downloads running.

### Usenet posts it can't open

A Usenet post packed in RAR archives, or with scrambled file names (only its PAR2 repair files named), can't be listed before it is downloaded. Backfill marks it as one it couldn't check. The admin agent can take such a post whole when its name is exactly the movie or one missing episode; once the Usenet client has it, its one video is imported.

### When an indexer limits you

Many indexers allow only so many searches or downloads a day, then answer "too many requests" until they reset. Backfill doesn't count that as a failure:

- The download stays queued, saying when it will try again ("Tabula Rasa has reached its download limit; trying again at 5:10 PM").
- It waits as long as the indexer says, or 15 minutes, then 30, an hour and so on, at most 6 hours between tries. Other downloads from that indexer wait too; other indexers carry on. Waits survive a restart.
- When Prowlarr is at its own search limit, a search stops at the first name and says so.
- After a day, Backfill gives up on that download; the pack stays on the title's page to approve by hand later, and the notification says so.

A download that can't start for another reason (a refused API key, a client not answering) is tried each minute, ten times. After any download fails to start, Backfill won't take that pack by itself for a day: it waits on the title's page, with the reason.

A download's activity counts repeats ("tried 9 times, last at 3:53 PM"), puts known problems in plain words ("SABnzbd did not answer"), and says who approved it: an admin (with "(API key)" if through the API), "AI agent", or Backfill itself. The exact error is in the server log.

### What each download client does

Backfill adds a pack with only the chosen files picked, follows it, has Sonarr or Radarr import them, and removes the download with what is left of it. Every client does that; what differs:

| Client | Category | Magnet links | Removing |
|---|---|---|---|
| qBittorrent | A category | Stop by themselves once their file list is in | With its files |
| Transmission | A label (3.0 and newer) | Held at 1 KB/s until the files are chosen, seconds later | With its files |
| Deluge | A label, when the Label plugin is on | Held at 1 KiB/s until the files are chosen, seconds later | With its files |
| rTorrent / ruTorrent | ruTorrent's label | Watched every few seconds until the files are chosen | Its files deleted one by one, then empty folders, through rTorrent's `execute` command |
| SABnzbd | A category | | With its files |
| NZBGet (16 and newer) | A category | | From the queue with what it downloaded, or from the history; the finished folder's leftovers (an .nfo, a sample) stay, as the videos were moved out by the import |

Without a category or label, a magnet link Backfill was reading when Seerr AI stopped is not cleared away by it. The Health page says when a client is missing something Backfill uses.

## The admin agent

An AI with tools that looks further when Backfill finds nothing usable for a requested title. It needs AI set up, with **Admin Agent** on.

**It can:** read why Sonarr, Radarr and Lidarr turned releases down; find a title and see what it has; run Sonarr's, Radarr's or Lidarr's own search; search Prowlarr with any words; list a release's files and check its language; download what is missing; relink a file that holds two episodes; ask you a question; stop its own download; request a title that isn't in the library yet.

**Albums**, while Backfill does music: it finds an album in Lidarr by its name or its artist, sees which tracks are missing, and searches Lidarr and Prowlarr's music. An album that isn't in Lidarr it finds on MusicBrainz, and requests when you ask it to. When it takes a release, Backfill matches the files to the album's tracks, as it does for its own finds, and only missing tracks are downloaded. To replace a track, or block a release group, it asks you first, as for films and series.

**It can't, on its own:** replace or touch a file already on disk; download a language other than English or the title's original language; go past its size or daily limits.

- **On its own** (on by default; **Step in on its own** in Settings → Backfill): when Backfill finds nothing for a requested title, or someone reports a title missing and Sonarr, Radarr and Backfill find nothing. Once per title; after that Sonarr, Radarr and Backfill keep searching without it.
- **When asked:** from **Backfill → Agent**, or **Get it with AI** on a title's Backfill page.
- **Limits** (Settings → Backfill → Advanced): 12 runs a day on its own, 10 downloads a day, 40 GB at most, 30 steps per go (searches run at once count as one), carrying on by itself with a fresh go up to 3 times, as long as its last go started a download. A change waiting for your approval, a replaced season being followed, and looking again after a failed download (below) aren't runs of its own: they don't count towards the 12, and don't keep it from looking into a title someone reports.
- **Standing instructions**: what it should always do, in your words ("always check it's English before downloading", "prefer Usenet", "nothing under 720p for new shows").
- **While it works**, you can tell it something ("that's the wrong show", "skip the specials"): it reads it before its next step. **Stop** stops it before its next step; downloads it already started carry on, and replying later picks up where it was.
- **Episode numbering**: releases often number episodes their own way (a special counted as episode 1, or the scene's seasons, which Sonarr goes by for some series). The agent goes by each episode's title: search results say which library episode each release is, a file whose title is another episode is never taken for this one, and a release named by the library's numbers is taken when its title agrees, even if Sonarr reads it as another episode.
- **Asked for everything missing**, it doesn't stop while there are missing episodes it never searched for: it's told which, once, and looks for each. Specials are searched for by the show's name and their titles first.
- **It remembers each title**: its searches and what they found, the releases it started, those that failed and those it turned down for being in another language. The next conversation about the title is told, so it doesn't repeat searches that found nothing or take what failed. Kept as long as Backfill waits before searching a title again.
- Every conversation is kept, step by step, with what it cost; you can reply to it or answer its questions. Finished ones are removed after 30 days; ones waiting for your answer are kept. **Clear finished** removes them now, except those whose downloads are still going, and never touches what they downloaded.

What it does shows in each title's history and in Backfill notifications.

### When a download it started fails

Backfill first takes a good pack it already found for the same episodes. If there's none, the agent gets the failure in the same conversation ("Download #63 failed … Find another release for S06E03; do not pick the same release or group again") and looks again, with the same say as before: a missing episode is just downloaded, while replacing a file still on disk waits for you. A release that failed is never taken again for that title.

- If the conversation is busy or waiting on you, it hears once that go is over.
- It stops after three failed replacements for the same episodes in a day, or when its daily downloads are used up, and sends a Backfill notification.
- If it finds nothing, you're told.
- With **Replace failed downloads** off, nothing is replaced: the next pack is offered to you.

### Changes you approve

When you ask it to, the agent can also change what's already there. It never does any of these by itself: it works out exactly what would happen, shows you, and waits. Nothing changes until you press **Approve** on the conversation's page.

- **Replace a file** with a release it found (a better copy, or the right one). The old file stays, and keeps playing, until the new one has imported.
- **Replace a whole season** ("season 6 is bad, replace it all"): the card says what it will download and how many files go after, for example "Replace season 6 of Quiet Ravens: download … and then remove the 5 current files". Approved, the new release is grabbed first; only then are the old releases marked failed in Sonarr and the old files removed so the new ones import. If nothing can be grabbed, nothing is removed. Asked to replace or fix something, the agent never proposes deleting the files first; deleting is only offered when deleting is what you asked for.
- **Search for a better release**: Radarr or Sonarr searches and takes one only if your quality profile prefers it. (This one just runs; it's what they'd do anyway.)
- **Block or unblock a release group** (see below).
- **Mark a download as failed**: it's removed from the download client and blocklisted, and Radarr or Sonarr looks for another.
- **Delete a title's files**: a movie's file, or a series' files (all, a season, or some episodes), and optionally stop them being downloaded again. If Radarr or Sonarr has no recycle bin set, the card says the file is gone for good, and Approve takes a second click.
- **Move a title to another quality profile**, and search again if you like.

Each change is checked again when you approve it. If things have moved on (a new file arrived, the download already finished), it's left alone and the agent tells you. You'll get a notification when something is waiting for you. Answering in the chat instead of approving drops the proposal; declining ends the conversation without changing anything.

Admins can ask for all of this from **AI Search** too ("this copy of The Driftwood is a cam, delete it and block the group"). AI Search hands it to the agent and links you to the conversation. Nobody else can, with one exception: anyone who can report issues can ask for a whole season to be replaced (see [Auto-fix](./subtitles-and-autofix.md#auto-fix)), and that waits here for an admin to approve or decline, like any other change. When Auto-fix finds no other release for a season, the agent looks further and can only propose replacing it.

### Blocked release groups

**Settings → Backfill → Blocked release groups.** Releases from a blocked group are never taken:

- Backfill and the agent pass over them.
- Radarr and Sonarr get a custom format called **Seerr AI: blocked release groups**. It matches the group by name (and in the release title, for torrents that only mention it there), and every quality profile scores it low enough that nothing carrying it can be grabbed.
- A file already in your library from a blocked group then counts as not good enough, so the next acceptable release replaces it, once it has imported.

Changes apply straight away. Seerr AI only ever touches that one format; your own custom formats are left as they are. If a server can't be reached, the list is still saved and you're told which server to check; it's brought in line the next time the list changes. Unblocking the last group removes the format.

