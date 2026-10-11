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
- **Downloads**: which download client takes torrent packs and which takes Usenet packs (add qBittorrent and SABnzbd under **Settings → Services → Download Clients** first), and the **category** Backfill uses, kept apart so Sonarr and Radarr don't import on their own.
- **When a title is stuck**: hours since the last search, movies too, whether files below the cutoff count as gaps.
- **Approval**: approve some packs automatically (only ones that fill what is missing, replace nothing, score at least 700 and are no bigger than 25 GB, by default), and **Replace failed downloads** (on by default: the next good pack is taken when one fails or stalls).
- **Advanced**: titles searched per scan, days before searching again, specials, downloads at once, space to keep free, when to give up on a stalled torrent, how long to keep history, and the agent's limits. The defaults suit most servers.

### The Backfill pages

- **Backfill** in the sidebar: what is stuck, packs found, ignored and complete, with a search box. **Scan now**, **Start search…** (with extra names to search under) and **Search All Stuck**.
- **A title's Backfill page**: what is missing and why Sonarr or Radarr didn't get it, each pack found with its file plan, approve or skip, history, Ignore, and **Get it with AI**.
- **A download's page**: progress, pause, resume or end.
- **On a title's own page**, admins see a Backfill box with what is missing, packs waiting and downloads running.

### Usenet posts it can't open

A Usenet post packed in RAR archives, or with scrambled file names (only its PAR2 repair files named), can't be listed before it is downloaded. Backfill marks it as one it couldn't check. The admin agent can take such a post whole when its name is exactly the movie or one missing episode; once SABnzbd has it, its one video is imported.

## The admin agent

An AI with tools that looks further when Backfill finds nothing usable for a requested title. It needs AI set up, with **Admin Agent** on.

**It can:** find a title and see what it has; run Sonarr's or Radarr's own search; search Prowlarr with any words; list a release's files and check its language; download what is missing; relink a file that holds two episodes; ask you a question; stop its own download; request a title that isn't in the library yet.

**It can't:** replace or touch a file already on disk; download a language other than English or the title's original language; go past its size or daily limits.

- **On its own** (on by default; **Step in on its own** in Settings → Backfill): when Backfill finds nothing for a requested title, or someone reports a title missing and nothing is found. Once per title.
- **When asked:** from **Backfill → Agent**, or **Get it with AI** on a title's Backfill page.
- **Limits** (Settings → Backfill → Advanced): 12 runs a day on its own, 10 downloads a day, 40 GB at most, 30 steps per go, carrying on by itself up to 3 times, as long as its last go started a download.
- **Standing instructions**: what it should always do, in your words ("prefer Usenet", "nothing under 720p for new shows").
- Every conversation is kept, step by step, with what it cost; you can reply to it or answer its questions. Finished ones are removed after 30 days.

What it does shows in each title's history and in Backfill notifications.
