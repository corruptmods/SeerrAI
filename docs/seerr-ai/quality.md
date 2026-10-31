# Quality profiles

[← Seerr AI guide](./README.md)

**Settings → Quality** (admins) has Seerr AI set up quality profiles in Radarr and Sonarr for you, from its own presets or from [TRaSH Guides](https://trash-guides.info), with your adjustments on top. It is off until you turn it on for a server, and nothing is sent to a server until you press **Apply**.

## What it changes, and what it doesn't

- **Only what it creates.** Every profile and custom format it makes is named `Seerr AI · …`, such as `Seerr AI · 1080p`; a TRaSH Guides format whose name Seerr AI's own already uses ends in `(TRaSH Guides)`, since Radarr and Sonarr need each name once. Your own profiles, and the titles on them, stay as they are.
- **One shared setting.** "Prefer usenet" changes the delay profile that titles without tags use, which affects every profile on that server. The preview marks it **Shared setting**.
- **Titles move only if you choose.** The preview can move the titles on your own profiles onto Seerr AI's; each is off unless you pick a profile. Undo moves them back.
- **New servers start as Not managed**, and TRaSH Guides updates wait for you unless you turn on **Apply updates automatically**.

Sonarr needs v4 or later (custom formats). Sonarr v5 keeps file sizes on each profile; Sonarr v4 keeps them for the whole server, so there they stay as Sonarr has them. In Radarr the size limit is a custom format.

## Setting up a server

1. Pick the server under **Servers** and turn on **Manage this server**.
2. Under **Presets**, choose where each comes from: **Seerr AI**, **TRaSH Guides**, or **Off** (not created). The presets are SD, 720p, 1080p, 1080p Remux, 2160p, 2160p Remux and Anime. A 4K server starts with 2160p; others with 1080p and Anime.
3. Set the **Adjustments** (below), or **Copy from another server**.
4. **Preview & apply** lists each change: **Create**, **Update**, **Put back** (someone changed it in Radarr or Sonarr), **Kept** (you kept their change). Press **Apply**.

Each server has its own presets and adjustments, so a 4K server and an anime server can differ.

## Adjustments

| Setting | Choices | What it does |
|---|---|---|
| **Prefer usenet** | At equal quality (recommended), Whenever usenet has it, No preference | At equal quality: near-equal releases tie, and usenet wins a tie. Whenever usenet has it: torrents also wait (2 hours to start; you set it), so usenet gets the first chance. |
| **File size** | Smaller files, Balanced, Best quality | How big a release may be. In Radarr a film over the limit is a last resort; in Sonarr v5 it's the most each quality takes a minute. |
| **Languages** | English or the original language, The original language, Any | Audio the release must have. A name that doesn't say its language is fine. |
| **HDR and Dolby Vision** | On or off | Preferred on 2160p presets. |
| **Allow x265 at 1080p** | On or off | Smaller files; some older TVs can't play them. Off makes it never taken below 2160p. |
| **Dual audio for anime** | On or off | The English dub with the original audio comes first. |
| **Single episodes first** | On or off | Sonarr: files with more than one episode only as a last resort. |
| **Burned-in subtitles as a last resort** | On or off | Only when nothing else is out. |
| **AV1 as a last resort** | On or off | Many TVs and streaming boxes can't play AV1, so Plex converts it as you watch. On: taken only when nothing else is out (TRaSH Guides never takes it; this goes on top). Off: taken like any other. |

Under **Advanced**:

- **Band step** (50, 100, 250 or 500): scores round to it, so releases that are nearly as good tie, and usenet wins. Bigger means more ties.
- **Moving a format**: any custom format on the server can go **Up a band**, **Down a band**, or to **Never**.

## TRaSH Guides

Choosing TRaSH Guides for a preset uses its profile of that name (such as *HD Bluray + WEB* for 1080p), with its custom formats and scores, and your adjustments on top. It is fetched from GitHub the first time a preset uses it, then checked for changes once every 24 hours (and before a preview, if the last check is older than that); **Check now** checks straight away. Health says if GitHub hasn't answered for 3 days.

- **Fill gaps with Seerr AI** (on to start): TRaSH Guides has no SD or 720p profile, so Seerr AI builds those, and adds its own rules (language, burned-in subtitles, sizes) beside TRaSH's formats.
- **Apply updates automatically** (off to start): when TRaSH Guides changes, a managed server shows **TRaSH update ready** until you preview and apply it. When on, the hourly check applies each update, listed in History with Undo, onto the choices you last applied: choices saved but not yet applied wait for you, the delay profile is never changed this way, changes made in Radarr or Sonarr aren't put back, and after an Undo nothing more is applied by itself until you apply again.

TRaSH Guides is used under its MIT licence, copyright TRaSH.

## What it does

Tap a preset's **What it does** to see, in words, what that profile does on that server:

- **In short**: what it takes first and what it upgrades to.
- **Qualities, best first**, with the lowest it takes, and what isn't allowed.
- **What it prefers**, in bands, what **counts for nothing**, what's a **last resort**, and what it **never takes**. Each shows where it came from (Seerr AI or TRaSH Guides) and anything you changed.
- **When two releases tie**: better quality, then higher score, then usenet or torrent (the delay profile), then the indexer you rank higher.
- **Try a release name**: paste one and see whether it would be grabbed, and why not.
- **Recent grabs** onto the profile, and whether Seerr AI or Radarr/Sonarr picked it.

## When someone changes it in Radarr or Sonarr

The hourly **Quality Profiles Check** job compares each managed server with what Seerr AI set. If a profile or format was changed or removed there, the server shows **Changed in Radarr** (or Sonarr), Health lists it, and you choose:

- **Put it back**: opens the preview; applying restores what Seerr AI set.
- **Keep their change**: it stays as edited, and Seerr AI leaves it alone until you put it back.

## History and Undo

Each apply is listed under **History**, with who applied it. **Undo** restores what it changed, removes what it created, and moves back titles still where it put them. Undo the newest first, while the server is managed. A profile still used by titles or by a server's request settings stays, and Undo says so.

**Apply** applies exactly what the preview showed: if the server or your choices changed in between, it says so and shows the new preview instead. If an apply stops part way (the server stops answering, say), what it did is still in History, so Undo can put it back.

**Stop managing** leaves the profiles in Radarr or Sonarr, still working; Seerr AI just stops changing them.

## Stepping down a preset

Off unless you turn it on, in **Settings → Backfill → Step down a quality preset**. A monitored title on one of Seerr AI's presets that has nothing after the days you set (30 to start) moves to the next looser preset (2160p Remux → 2160p → 1080p → 720p → SD, 1080p Remux → 1080p) and is searched. Once a file arrives it moves back, so upgrades carry on. Up to 10 titles a server are moved every 6 hours.
