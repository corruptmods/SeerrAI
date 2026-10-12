# What's new in Seerr AI

The newest changes are at the top. **Coming next** is what's on the `dev` branch and not in a release yet: it's what you get if you build from `dev` or run the `develop` image.

## Coming next

### Ready for Sonarr v5

The Sonarr v5 beta works with Seerr AI. Backfill and the admin agent understand how v5 describes season packs and releases with no season in the name, so a pack of several seasons is no longer left out of a search for one of them. When a series is shown under a translated title in Sonarr, Backfill also looks for it under its original title. Sonarr v4 works just as before.

### Seerr AI in your language

Every screen, button and notification is now translated into 40 languages, including everything Seerr AI added on top of Seerr. Basque, Kabyle, Slovak and Slovenian join the language picker, and notifications in Chinese now actually arrive in Chinese. Some older translations also had small mistakes, like showing "Plex" to Jellyfin users or an old app name instead of Seerr AI, and those are fixed too. Spot something that reads oddly in your language? Open an issue and we'll fix it.

### Jellyfin and Emby get the full experience

Suggested for You, Who Watched, Pick for the Room, Catch Me Up, "up next" on your lists and AI Search knowing what you've watched now work on Jellyfin and Emby too, straight from your server, with nothing extra to set up. Health shows your Jellyfin or Emby server and its version, and the nightly Match Check now spots titles Jellyfin or Emby matched wrongly and tells you exactly what to enter in **Identify**.

### Ask the agent to fix what's already there

The admin agent can now replace a bad copy, block a release group, mark a download as failed, delete files, switch a title to another quality profile, or look for a better release. Just ask it, in its chat or in AI Search. It shows you exactly what it would do and waits for your **Approve**, so nothing changes behind your back. A replaced file stays playable until the new one is in.

### Block release groups

Got a group that keeps uploading fakes? Add it under **Settings → Backfill → Blocked release groups**. Backfill, the agent, Radarr and Sonarr will all skip its releases from then on, and anything you already have from it gets swapped out for the next good release.

### More download clients

Seerr AI now works with NZBGet, Transmission, Deluge and rTorrent (ruTorrent too), as well as SABnzbd and qBittorrent. Add them under **Settings → Services → Download Clients**. Downloads then update every few seconds, and you can see what the client is actually doing: checking, repairing, unpacking, or waiting for someone to download from.

### Backfill works with all of them

Backfill can now send what it finds to any of those clients, torrents and Usenet alike. Pick yours under **Settings → Backfill**. Each download still fetches only the files it needs, and is cleaned up once Sonarr or Radarr has imported them.

A few clients need one thing switched on first:

- **Deluge**: turn on the Label plugin (Preferences → Plugins).
- **rTorrent**: it needs to be allowed to run commands, which is how finished downloads get cleaned up. If ruTorrent's "erase data" works for you, you're set.
- **Transmission**: version 3.0 or newer.
- **NZBGet**: version 16 or newer. It keeps a small leftover folder after a download (an .nfo or a sample); the video itself is moved into your library.

### Health knows your download clients

The Health page now shows which client each one is and what version it's running. If the one Backfill uses is missing something from the list above, Health tells you what to switch on.

### Your own networks

Everyone can now choose which networks their Networks row shows. Tap the pencil on the home page to customize it, then add networks by their TMDB id, put them in any order, or remove them, up to 50. It's just for you, and until you change it you get the usual list.

### Tap a download to see it

On a phone, tapping a title's download pill now shows what's downloading (progress, time left, what it's doing) instead of jumping straight to Plex. The Play on Plex link is right there in the details.

### Real logos

Your download clients, Bazarr and Tautulli now show their own logos in **Settings → Services**, just like Radarr, Sonarr and Maintainerr, so it's easy to see which is which at a glance.

### Tautulli has moved

Tautulli is now under **Settings → Services**, next to everything else, with a button to test it and one to remove it. Your existing settings came along with it, so there's nothing to redo.

## 1.0.0 (11 October 2026)

The first release of Seerr AI: AI Search, Backfill and its admin agent, the Health page, watch lists, the release calendar, live download status, and more. The [README](./README.md) shows what's included, and the [guide](./docs/seerr-ai/README.md) covers each feature.
