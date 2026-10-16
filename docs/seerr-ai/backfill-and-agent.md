# Backfill and the admin agent

[← Seerr AI guide](./README.md)

Sonarr and Radarr search their indexers and give up quietly when nothing matches their rules: an episode missing from a season, a show listed under another name, a pack they won't take because one file is wrong. Backfill picks up from there. Admins only.

## What Backfill does

1. Every 6 hours (the **Backfill Scan** job) it finds series and movies that Sonarr or Radarr searched for and didn't grab, once their last search is older than **Stuck after** (24 hours by default).
2. It searches Prowlarr itself, under every name the title goes by, a few titles per scan (requested titles first).
3. It opens the likeliest packs (reading the torrent or NZB, without downloading it) and asks Sonarr or Radarr how they would import each file and whether it meets the quality profile.
4. It offers the packs that fill what is missing, with a score and a plan for each file, and sends a **Backfill** notification.
5. When a pack is approved, it downloads only the chosen files to its own category, imports them through Sonarr or Radarr, and cleans up. Torrents aren't seeded afterwards.

Approval can be **Missing episodes only** (recommended), or **Missing and upgrades**, which replaces files on disk and asks you to type the title's name to confirm.

### Setting it up

**Settings → Backfill**:

- **Prowlarr**: address and API key.
- **Downloads**: which download client takes torrent packs and which takes Usenet packs (any of the clients under **Settings → Services → Download Clients**: qBittorrent, Transmission, Deluge or rTorrent for torrents, SABnzbd or NZBGet for Usenet), and the **category** Backfill uses, kept apart so Sonarr and Radarr don't import on their own.
- **When a title is stuck**: hours since the last search, movies too, whether files below the cutoff count as gaps.
- **Approval**: approve some packs automatically (only ones that fill what is missing, replace nothing, score at least 700 and are no bigger than 25 GB, by default), and **Replace failed downloads** (on by default: the next good pack is taken when one fails or stalls).
- **Advanced**: titles searched per scan, days before searching again, specials, downloads at once, space to keep free, when to give up on a stalled torrent, how long to keep history, and the agent's limits. The defaults suit most servers.

### The Backfill pages

- **Backfill** in the sidebar: what is stuck, packs found, ignored and complete, with a search box. **Scan now**, **Start search…** (with extra names to search under) and **Search All Stuck**.
- **A title's Backfill page**: what is missing and why Sonarr or Radarr didn't get it, each pack found with its file plan, approve or skip, history, Ignore, and **Get it with AI**.
- **A download's page**: progress, pause, resume or end. A failed one says what became of it, linked: **Replaced by #66**, **Backfill is searching for another release**, **The admin agent is looking for another release**, **Backfill offered the next pack**, or **Nothing else was found**. The title's list of downloads says the same under each failed one.
- **On a title's own page**, admins see a Backfill box with what is missing, packs waiting and downloads running.

### Usenet posts it can't open

A Usenet post packed in RAR archives, or with scrambled file names (only its PAR2 repair files named), can't be listed before it is downloaded. Backfill marks it as one it couldn't check. The admin agent can take such a post whole when its name is exactly the movie or one missing episode; once the Usenet client has it, its one video is imported.

### When an indexer limits you

Many indexers allow only so many searches, or so many downloads of a torrent or NZB file, a day. Once that is used up they answer "too many requests" until it resets. Backfill doesn't treat that as a failed download:

- The download stays queued, and its page says so: for example "Tabula Rasa has reached its download limit; trying again at 5:10 PM".
- It isn't tried again before then. When the indexer says how long to wait, Backfill waits that long; otherwise 15 minutes, then 30, an hour, two hours and so on, never more than 6 hours between tries.
- Other downloads from the same indexer wait too, without asking it. Packs from other indexers carry on as usual. The waits are kept when Seerr AI restarts.
- When Prowlarr itself is at its search limit, a search stops at the first name rather than spending more searches, and says so on the title's page.
- After a day of waiting, Backfill gives up on that download. The pack stays on the title's page for you to approve by hand when the indexer has reset, and the notification says so.

A download that couldn't start for any other reason (the indexer refused the API key, the download client didn't answer) is tried each minute and given up after ten tries. Whatever the reason, Backfill doesn't take a pack by itself again for a day after its download failed to start: it waits on the title's page, with why beside it, for you to approve it by hand.

A download's activity says each thing once: when the same thing happens again, the line counts it ("tried 9 times, last at 3:53 PM") rather than being written again. Known problems are put in plain words ("SABnzbd did not answer", "Tabula Rasa refused the API key"); the exact error is in the server log. Each download says who approved it: the admin by name, "(API key)" after the name when it was approved through the API, "AI agent", or Backfill when it took the pack itself.

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

**It can:** find a title and see what it has; run Sonarr's or Radarr's own search; search Prowlarr with any words; list a release's files and check its language; download what is missing; relink a file that holds two episodes; ask you a question; stop its own download; request a title that isn't in the library yet.

**It can't, on its own:** replace or touch a file already on disk; download a language other than English or the title's original language; go past its size or daily limits.

- **On its own** (on by default; **Step in on its own** in Settings → Backfill): when Backfill finds nothing for a requested title, or someone reports a title missing and nothing is found. Once per title.
- **When asked:** from **Backfill → Agent**, or **Get it with AI** on a title's Backfill page.
- **Limits** (Settings → Backfill → Advanced): 12 runs a day on its own, 10 downloads a day, 40 GB at most, 30 steps per go, carrying on by itself up to 3 times, as long as its last go started a download. A change waiting for your approval, a replaced season being followed, and looking again after a failed download (below) aren't runs of its own: they don't count towards the 12, and don't keep it from looking into a title someone reports.
- **Standing instructions**: what it should always do, in your words ("prefer Usenet", "nothing under 720p for new shows").
- Every conversation is kept, step by step, with what it cost; you can reply to it or answer its questions. Finished ones are removed after 30 days.

What it does shows in each title's history and in Backfill notifications.

### When a download it started fails

When a download the agent started fails (SABnzbd gives up on it, say, or a torrent stalls), Backfill first takes a good pack it already found for the same episodes, as it does for any failed download. If there is none, the download goes back to the agent, in the same conversation: "Download #63 failed (SABnzbd could not finish it: Aborted, cannot be completed). Find another release for S06E03; do not pick the same release or group again." It looks the way it did before, with the same say as before: a missing episode is simply downloaded again, even if deleting the old file needed your approval, while replacing a file that is there still waits for you. A release that failed is shown to it as failed and is never taken again for that title, wherever it is found.

- If the conversation is still going, or waiting on your answer, it hears of the failure once that go is over.
- It stops after three replacements for the same episodes have failed in a day, or when its downloads for the day are used up, and you get a Backfill notification saying so.
- If it finds nothing, you're told the download failed and nothing else was found.
- With **Replace failed downloads** off, nothing is replaced, by Backfill or the agent: the next pack is offered to you instead.

### Changes you approve

When you ask it to, the agent can also change what's already there. It never does any of these by itself: it works out exactly what would happen, shows you, and waits. Nothing changes until you press **Approve** on the conversation's page.

- **Replace a file** with a release it found (a better copy, or the right one). The old file stays, and keeps playing, until the new one has imported.
- **Replace a whole season** ("season 6 is bad, replace it all"): the card says what it will download and how many files go after, for example "Replace season 6 of Slow Horses: download … and then remove the 5 current files". Approved, the new release is grabbed first; only then are the old releases marked failed in Sonarr and the old files removed so the new ones import. If nothing can be grabbed, nothing is removed. Asked to replace or fix something, the agent never proposes deleting the files first; deleting is only offered when deleting is what you asked for.
- **Search for a better release**: Radarr or Sonarr searches and takes one only if your quality profile prefers it. (This one just runs; it's what they'd do anyway.)
- **Block or unblock a release group** (see below).
- **Mark a download as failed**: it's removed from the download client and blocklisted, and Radarr or Sonarr looks for another.
- **Delete a title's files**: a movie's file, or a series' files (all, a season, or some episodes), and optionally stop them being downloaded again. If Radarr or Sonarr has no recycle bin set, the card says the file is gone for good, and Approve takes a second click.
- **Move a title to another quality profile**, and search again if you like.

Each change is checked again when you approve it. If things have moved on (a new file arrived, the download already finished), it's left alone and the agent tells you. You'll get a notification when something is waiting for you. Answering in the chat instead of approving drops the proposal; declining ends the conversation without changing anything.

Admins can ask for all of this from **AI Search** too ("this copy of The Odyssey is a cam, delete it and block the group"). AI Search hands it to the agent and links you to the conversation. Nobody else can, with one exception: anyone who can report issues can ask for a whole season to be replaced (see [Auto-fix](./subtitles-and-autofix.md#auto-fix)), and that waits here for an admin to approve or decline, like any other change. When Auto-fix finds no other release for a season, the agent looks further and can only propose replacing it.

### Blocked release groups

**Settings → Backfill → Blocked release groups.** Releases from a blocked group are never taken:

- Backfill and the agent pass over them.
- Radarr and Sonarr get a custom format called **Seerr AI: blocked release groups**. It matches the group by name (and in the release title, for torrents that only mention it there), and every quality profile scores it low enough that nothing carrying it can be grabbed.
- A file already in your library from a blocked group then counts as not good enough, so the next acceptable release replaces it, once it has imported.

Changes apply straight away. Seerr AI only ever touches that one format; your own custom formats are left as they are. If a server can't be reached, the list is still saved and you're told which server to check; it's brought in line the next time the list changes. Unblocking the last group removes the format.

