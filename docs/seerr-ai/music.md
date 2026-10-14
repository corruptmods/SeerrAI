# Music

[← Seerr AI guide](./README.md)

Seerr AI can take requests for music as well as films and series. Music goes through Lidarr the way films go through Radarr, and shows as here once your media server's music library has it.

Nothing about music appears until an admin adds a Lidarr server. After that, everyone who can request films and series can request music too.

## Setting it up (admins)

1. **Add Lidarr** under **Settings → Services → Lidarr**: its address and API key, then the quality profile, metadata profile, root folder and tags new artists get. Mark one Lidarr as the default; music appears for everyone once there is one. **Enable Scan** also brings what Lidarr already has into Seerr AI, so those albums show as here and aren't requested again.
2. **Switch on your music libraries** under **Settings → Plex**, **Jellyfin** or **Emby**, in the **Music Libraries** section (press **Sync Libraries** first if it's empty). An album counts as here once any connected server's music library lists it.
3. Optionally, **Settings → Metadata → Music**: a MusicBrainz mirror of your own, a contact address for MusicBrainz, whether the New Music, Popular Albums and Popular Artists rows come from ListenBrainz, a TheAudioDB key for pictures of artists Lidarr has none of, and the most albums one request may ask for.

Worth turning on in Lidarr: **Settings → Metadata → Write Audio Tags**. Jellyfin and Emby find an album's MusicBrainz ids in its files' tags; without them, albums are matched by folder name, then by title and year, which is usually right but not always.

If no music library is switched on anywhere, Lidarr's files decide instead: an album with all its tracks is here, one with some of them is partly here.

## Finding music

Search finds artists and albums as well as films and series, in a section of its own. Discover gains four rows: **Recently Added Music**, **New Music**, **Popular Albums** and **Popular Artists**. They can be moved or hidden like any row, and the **Music** item in the sidebar opens all of them.

An artist's page lists everything they have released, grouped as albums, EPs, singles and the rest (live albums, compilations, soundtracks and remixes, folded away). An album's page has its cover and track list, and **Play** on each server that has it.

Artist and album details come from MusicBrainz, which answers one request a second for each server. A page that would have to wait too long says MusicBrainz is busy and offers to try again; it is rarely needed twice.

## Requesting music

- **Request** on an artist's page opens a window listing their releases. What starts ticked follows the Lidarr metadata profile: if Lidarr would list only studio albums, only those are ticked. Untick what you don't want, or tick everything for a whole discography.
- **Request Album** on an album's page, or the small button on an album's card, asks for just that album.

However many albums are ticked, it is **one request**, approved once. Albums already here, or already asked for by someone, are left out. Various Artists compilations can't be requested, because Lidarr can't add Various Artists.

Who can ask, and how much:

- **Request** covers music, as it covers films and series. For someone who should only ask for music, give them **Request Music** instead (Users → a person → Permissions).
- **Auto-Approve** covers music too; **Auto-Approve Music** approves only music requests.
- Albums have their own limit, like seasons for series: **Global Album Request Limit** under **Settings → Users**, and an album limit on each person's settings.

## What happens after approval

The request goes to Lidarr.

- **An artist Lidarr doesn't have yet** is added with only the albums asked for monitored, using the request's profile and folder.
- **An artist Lidarr already has** keeps its own folder, profiles and new-release setting. The albums asked for are monitored and searched for, any Lidarr is missing are added, and nothing anyone else asked for is ever unmonitored.

Lidarr's own metadata service sometimes takes days to learn about a new album. Seerr AI keeps trying for a week; after that the request is marked failed with the reason, and can be retried.

While Lidarr downloads, the status pill on the album, the artist and the request shows how far along it is, as it does for films. Once Lidarr has the files and your media server hasn't listed them yet, it says **Adding to Plex** (or Jellyfin, or Emby).

## When it arrives

**Music Sync** runs every five minutes, and a minute after Lidarr imports something: it reads what each server's music libraries added recently, and follows Lidarr's progress. The **Music Full Scan** reads every music library, and all of Lidarr, each night.

Each album asked for is done once it's here. When every album in a request is here, the request is complete and whoever asked is told, along with anyone watching the request, once, on whichever notification channels they use. An album that is deleted again later is marked deleted, and can be requested again.

An artist shows as **Partially Available** once any of their albums is here, and **Available** once every album asked for, or monitored in Lidarr, is.

## For admins

**The Manage panel** (the cog on an artist's page, for request managers and admins) shows what Lidarr is downloading of theirs, every request for them (approve, decline, edit or delete each), and their history: who asked for which albums, approvals, and each album arriving or leaving. Admins also get **Open in Lidarr**, **Search Lidarr for Missing Albums**, and **Clear Data**, which removes Seerr AI's own record of the artist and their requests and leaves Lidarr alone.

**Health** (Settings → Health) checks Lidarr like Radarr and Sonarr, and adds:

- **Albums in Lidarr, not on your media server after a day**: usually a music library that's switched off, not scanned, or not looking at Lidarr's folder.
- **Requested albums with no release found after a week**, each with **Search now**, which asks Lidarr to look again. Albums not released yet aren't listed.
- **MusicBrainz**: whether it has been answering over the last hour, saying it's over its limit, or turning people away as busy. A mirror of your own (Settings → Metadata → Music) has no limit.

**Webhooks** get `media_type` `music`, the artist's MusicBrainz id as `media_mbid`, and the albums asked for as `music_albums`; `media_tmdbid` is 0. Anything that reads Seerr's webhooks should expect them.

## Turning it off

An admin can switch **Music** off for everyone under **Settings → Features**: the Music item, music in search, the music rows on Discover, music requests and the music settings all go away, and the server refuses music for everyone. Anyone can also switch it off for themselves under **Profile → Settings → Features**.

## What music doesn't do yet

Backfill and the admin agent, AI Search and picks, watch lists and Roulette, Suggested for You and Who Watched, the blocklist, issues, the calendar, override rules, and following an artist's new releases are for films and series only, for now.
