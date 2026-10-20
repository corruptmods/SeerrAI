# Music

[← Seerr AI guide](./README.md)

Seerr AI takes requests for music too. Music goes through Lidarr, as films go through Radarr, and shows as here once your media server's music library has it.

Music appears once an admin adds Lidarr. Anyone who can request films and series can then request music.

## Finding music

- **Music** in the sidebar: new music, popular albums and artists, and a search box for artists and albums.
- **Search**: pick **Music** above the results for artists and albums. **All** keeps to films, series, collections and people, unless an admin adds music below them.
- **Discover** gains **Recently Added Music**, **New Music**, **Popular Albums** and **Popular Artists** rows.

Album and artist tiles say what they are (Album, EP, Single, Artist) and their status; hover or tap for the name, year and **Request**.

An artist's page lists their releases as albums, EPs and singles, with live albums, compilations and the rest folded away. An album's page has its tracks and a **Play on …** button for each server that has it.

Details come from MusicBrainz, which answers one request a second for each server. If a page would wait too long, it says MusicBrainz is busy and offers to try again.

A search shows up to 8 artists and 12 albums, the one you most likely mean first.

## Requesting music

**A whole artist, or several albums:**

1. Open the artist and press **Request**.
2. Tick the releases you want. What starts ticked follows Lidarr's metadata profile; **All albums** (or **All EPs**, **All singles**) ticks a group.
3. Press **Request N Albums**.

**One album:** press **Request Album** on its page, or **Request** on its tile.

However many albums you tick, it's **one request**, approved once. Albums already here or already requested are left out. Various Artists compilations can't be requested (Lidarr can't add Various Artists).

While Lidarr downloads, the status shows how far along it is, then **Adding to Plex** (or Jellyfin, or Emby) until your library lists it. When every album in the request is here, you're told once, on your usual notification channels.

An artist shows **Partially Available** once any album is here, and **Available** once every album asked for (or monitored in Lidarr) is.

Don't want music? Turn it off for yourself in **Profile → Settings → Features**.

## Setting it up (admins)

1. **Settings → Services → Lidarr**: add Lidarr with its address and API key, then the quality profile, metadata profile (which kinds of release Lidarr lists: albums, EPs, singles, live albums), root folder and tags new artists get. Make it the default; you can add more than one Lidarr. **Enable Scan** brings in what Lidarr already has, so those albums show as here.
2. **Music libraries**: tick them when connecting a server, or later under **Settings → Media Servers → Edit → Music Libraries** (press **Sync Libraries** if the list is empty). An album counts as here once any server's music library lists it. With none switched on anywhere, Lidarr's files decide.
3. **Settings → Music** (optional): **Include Music in All Search Results**, and under **Where Music Comes From**: a **MusicBrainz Address** (your own mirror has no limit), a **Contact Email** (so MusicBrainz can reach you instead of slowing every Seerr AI down), **New and Popular Music** (the ListenBrainz rows), a **TheAudioDB API Key** for artist pictures, and **Most Albums in One Request** (100 to start). The page links to the rest of music's settings.

In Lidarr, turn on **Settings → Metadata → Write Audio Tags**: Jellyfin and Emby match albums by the MusicBrainz ids in the tags; without them, by folder name and then title and year.

### Who can ask, and how much

- **Request** covers music. For music only, give someone **Request Music** instead (Users → a person → Permissions).
- **Auto-Approve** covers music; **Auto-Approve Music** approves only music.
- Album limits work like season limits: **Global Album Request Limit** in **Settings → Users**, and a limit on each person.

### What Lidarr is told

- **A new artist** is added with only the requested albums monitored, using the request's profile and folder.
- **An artist Lidarr has** keeps its own settings. Requested albums are monitored and searched for; nothing anyone else asked for is unmonitored.

Lidarr sometimes takes days to learn about a new album. Seerr AI keeps trying for a week, then marks the request failed with the reason; it can be retried.

### Keeping track

- **The Manage panel** (the cog on an artist's page) shows what Lidarr is downloading, every request (approve, decline, edit, delete), and the history. Admins also get **Open in Lidarr**, **Search Lidarr for Missing Albums** and **Clear Data** (removes Seerr AI's own record; Lidarr is left alone).
- **Health** checks Lidarr, lists albums Lidarr has that no server lists after a day, requested albums with no release after a week (with **Search now**), and whether MusicBrainz is answering.
- **Music Sync** runs every five minutes and a minute after Lidarr imports; **Music Full Scan** reads every music library and all of Lidarr nightly (03:40).
- **Webhooks** get `media_type` `music`, the artist's MusicBrainz id as `media_mbid`, the albums as `music_albums`, and `media_tmdbid` 0.

### Turning it off

Switch **Music** off for everyone in **Settings → Music**: the Music page, music in search and on Discover, requests and the music settings go, and the server refuses music.

## Not for music yet

Backfill and the admin agent, AI Search and picks, watch lists, Suggested for You, Who Watched, the blocklist, issues, the calendar, override rules and following an artist's new releases are for films and series only.
