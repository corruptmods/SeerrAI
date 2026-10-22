# Download Check

[← Seerr AI guide](./README.md)

Sonarr and Radarr grab releases they then can't import, and some that aren't what they say: a fake with a program in it, an episode posted days before it airs, another country's version of a show filed under yours, a copy no better than the file you have. When an import gets stuck, it sits in the queue until someone sorts it out. Download Check looks at both, twice a minute. Admins only. It doesn't use AI: every decision is a rule over what Sonarr, Radarr and the download client say.

## Turning it on

**Settings → Backfill → Download Check**: **Off**, **Report only** or **On**. Start with **Report only**: the Backfill page lists what it would do, and nothing changes. Switch to **On** once you agree with it; what it found with Report only is then done too, if the download is still in the queue.

It doesn't need Prowlarr or the rest of Backfill. A torrent's files are checked once your torrent client is added in **Settings → Services → Download Clients**.

## Before a download comes down

Checked as soon as Sonarr or Radarr takes it, and while a delay profile still holds it:

| Found | Done |
|---|---|
| A program in it (`.exe`, `.scr`, `.lnk`, `.bat` and the like), only archives, no video, or only a sample. Torrents, once the client has their file list | Rejected |
| Grabbed a day or more before the episode aired | Rejected |
| One episode whose name carries another episode's title (a series Sonarr reads by the scene's numbering, or a group's own numbering): it would go in as the wrong episode | Rejected. When the episode it really is is missing, Backfill looks for it, as it goes by titles |
| Another title: another country's version (The.Turnstile.AU for The Turnstile), another year (Gurneys.2026 for the 2001 series), or an episode whose title is another episode's | Rejected |
| No better than the file you have, compared as the import compares: quality, then revision, then custom format score | Rejected, not searched again |
| A single episode where your file holds two | Rejected, not searched again |
| A better copy of the same is in the queue | Removed, not blocklisted |

**Rejected** means taken out of the queue and the download client, blocklisted so it isn't grabbed again, and searched for again while what it was for is still missing.

## When an import gets stuck

It gets two minutes to clear by itself, then Sonarr's or Radarr's own reason decides:

| Reason | Done |
|---|---|
| Matched to the series or movie by ID | The name decides. The right title under another name (Bramble.&amp;.Finch-Trick.Us): imported. The right show numbered another way, when the episode it really is is missing (Snack.Kingdom.2013.S01E13 is S07E05, "Taco Kingdom 3"): imported as that episode. Another title, or an episode you have: rejected. When the name doesn't say: left for you |
| TheXEM hasn't confirmed the numbering, it couldn't tell if it's a sample, or it couldn't read the file name | Imported, each file as the episode Sonarr reads it as; a single episode's one video is that episode |
| Nothing in it can be imported: a sample, archives, the wrong episodes, no video | Rejected |
| Not an upgrade, or your file holds more episodes | Rejected, not searched again |
| Only part of a pack came in, or it's imported already | Cleared: out of the queue, left in the client, and what's still missing searched for |
| Anything else | Left for you |

An import never replaces a better file: such files are left out, and a download with nothing better in it is rejected instead.

## On the Backfill page

Download Check's box lists the newest findings and everything waiting for you, with the week's counts. Each shows what was found, what was done (or, with Report only, would be), the release, and for a stuck import Sonarr's or Radarr's own words under **What Sonarr said**. Use its buttons to do it, import or reject it instead, or **Leave** it.

Findings are kept as long as Backfill's history (90 days by default) and removed by the nightly **Database Maintenance** job; ones waiting for you stay until you decide.

## Alongside Cleanuparr and the like

Download Check acts within a few minutes of a grab or a stuck import, before tools that count strikes get there. Keep them for what it doesn't do: stalled and slow downloads, and seeding.
