# What's new in Seerr AI

The newest changes are at the top. **Coming next** is what's on the `dev` branch and not in a release yet: it's what you get if you build from `dev` or run the `develop` image.

## Coming next

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

### Tautulli has moved

Tautulli is now under **Settings → Services**, next to everything else, with a button to test it and one to remove it. Your existing settings came along with it, so there's nothing to redo.

## 1.0.0 (11 October 2026)

The first release of Seerr AI: AI Search, Backfill and its admin agent, the Health page, watch lists, the release calendar, live download status, and more. The [README](./README.md) shows what's included, and the [guide](./docs/seerr-ai/README.md) covers each feature.
