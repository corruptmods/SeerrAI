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
- **A download's page**: progress, pause, resume or end.
- **On a title's own page**, admins see a Backfill box with what is missing, packs waiting and downloads running.

### Usenet posts it can't open

A Usenet post packed in RAR archives, or with scrambled file names (only its PAR2 repair files named), can't be listed before it is downloaded. Backfill marks it as one it couldn't check. The admin agent can take such a post whole when its name is exactly the movie or one missing episode; once the Usenet client has it, its one video is imported.

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
- **Limits** (Settings → Backfill → Advanced): 12 runs a day on its own, 10 downloads a day, 40 GB at most, 30 steps per go, carrying on by itself up to 3 times, as long as its last go started a download.
- **Standing instructions**: what it should always do, in your words ("prefer Usenet", "nothing under 720p for new shows").
- Every conversation is kept, step by step, with what it cost; you can reply to it or answer its questions. Finished ones are removed after 30 days.

What it does shows in each title's history and in Backfill notifications.

### Changes you approve

When you ask it to, the agent can also change what's already there. It never does any of these by itself: it works out exactly what would happen, shows you, and waits. Nothing changes until you press **Approve** on the conversation's page.

- **Replace a file** with a release it found (a better copy, or the right one). The old file stays, and keeps playing, until the new one has imported.
- **Search for a better release**: Radarr or Sonarr searches and takes one only if your quality profile prefers it. (This one just runs; it's what they'd do anyway.)
- **Block or unblock a release group** (see below).
- **Mark a download as failed**: it's removed from the download client and blocklisted, and Radarr or Sonarr looks for another.
- **Delete a title's files**: a movie's file, or a series' files (all, a season, or some episodes), and optionally stop them being downloaded again. If Radarr or Sonarr has no recycle bin set, the card says the file is gone for good, and Approve takes a second click.
- **Move a title to another quality profile**, and search again if you like.

Each change is checked again when you approve it. If things have moved on (a new file arrived, the download already finished), it's left alone and the agent tells you. You'll get a notification when something is waiting for you. Answering in the chat instead of approving drops the proposal; declining ends the conversation without changing anything.

Admins can ask for all of this from **AI Search** too ("this copy of The Odyssey is a cam, delete it and block the group"). AI Search hands it to the agent and links you to the conversation. Nobody else can.

### Blocked release groups

**Settings → Backfill → Blocked release groups.** Releases from a blocked group are never taken:

- Backfill and the agent pass over them.
- Radarr and Sonarr get a custom format called **Seerr AI: blocked release groups**. It matches the group by name (and in the release title, for torrents that only mention it there), and every quality profile scores it low enough that nothing carrying it can be grabbed.
- A file already in your library from a blocked group then counts as not good enough, so the next acceptable release replaces it, once it has imported.

Changes apply straight away. Seerr AI only ever touches that one format; your own custom formats are left as they are. If a server can't be reached, the list is still saved and you're told which server to check; it's brought in line the next time the list changes. Unblocking the last group removes the format.

