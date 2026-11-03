# What's new in Seerr AI

Newest first. The [guide](./docs/seerr-ai/README.md) explains each feature.

## Coming next

### New

- **A song whose single Lidarr can't find is taken from an album instead**: older singles are seldom posted on their own, while their albums are. As soon as Lidarr's search for the single grabs nothing, the song is taken from the artist's album with the same recording, through Backfill, and Lidarr stops looking for the single. A song on no album is looked for by Seerr AI itself, from the single, searched again on the same schedule as albums. Songs already waiting move over on update, a few singles a minute.

- **Songs from singles Lidarr holds back are imported**: a single's download with just the song stops in Lidarr's queue with "Has missing tracks" when the single's edition also has a radio edit or an instrumental. Seerr AI now imports the requested song on its own, into its track. Health lists the downloads Lidarr still won't import, with its reason.

- **A playlist's page says what's happening to each requested song**: Lidarr searching for its single, Seerr AI searching for its album, nothing found yet and when it's searched again, waiting for a download slot, downloading with how far along, or importing, instead of just Requested.

- **Search again now** on a playlist's page: albums of its songs that found nothing yet, waiting hours to be searched again, are searched straight away.

### Fixed

- A song asked for again starts within a minute or so, instead of waiting behind every album due a search (after an update, all of them): setting up albums, starting downloads and imports now come before searches.

- A song whose title has an apostrophe ("Ain't", "It's", "O'Clock") is found in a download that drops it ("Aint"), as many do, and so is an album whose release is named that way. Such songs failed with "None of the songs were in the finished download".

- A song Lidarr's edition of its album lacks, with no other album to take it from, is taken from its own single instead of failing.

- Playlists: a song is no longer matched to a live, acoustic, piano or remixed take, or a Dolby Atmos or 360 mix, unless its title says so; such a take could be nearer the playlist's length than the song itself. A song with only such takes on MusicBrainz is shown as not found. Try again on a song whose request was deleted looks it up again.

- A song taken from an album is no longer taken from a Dolby Atmos, 360 Reality Audio, piano, session or other mix of it.

- The database warning "Calling client.query() when the client is already executing a query" on Postgres is gone: the database library sent some queries side by side on one connection, and now sends them one after another.

- A song taken from an album is only taken from a release of that album by that artist, and only from that song's own file. Live, remixed, instrumental, karaoke, tribute and re-recorded releases and files no longer count, nor another album of the artist's for a self-titled one, nor a whole album in one file; a title track is found by its own name, and two songs never share a file. A Usenet post's file list is now read before downloading it, as a torrent's is. A download Lidarr holds back is imported by Seerr AI only when Lidarr held it for missing tracks and it is named as the single.

- Songs no longer get stuck: a song whose single Lidarr has part of, or took an edition of without it, is taken by Seerr AI; a single handed over no longer counts as on its way, so its other songs can be asked for; Lidarr's search for a single is asked for once, an hour apart when it couldn't run, and its songs are handed over only once Lidarr's queue would show a grab. A song asked for while its album downloads waits for that download instead of starting a second. A Usenet download the client keeps paused is given up like a stalled torrent. Lidarr not answering during an import no longer fails the songs, nor finishes a song on a single that is here. A song is no longer marked here by another take of the same name. Songs coming through singles fail with their request when Lidarr can't take it, so they can be tried again.

- Playlists: a big import waiting for an admin goes as one batch again (it was asked for 40 songs at a time, each too few to need approval); a song taken off while it was being found stays off; Try again and Search again now are the owner's, and Try again leaves a blocklisted artist's request alone; songs an admin approved are searched again with Search again now too; a song whose request was deleted can be tried again; a song held back because songs can't be asked for one at a time says so.

- A live take only on a live single can be requested.

- A song on an album someone has asked for whole is no longer asked for again, and downloaded twice.

- A song Lidarr's edition of its album lacks is taken from the artist's next album with it, instead of failing; a song missing from the release chosen for others of its album is searched for again on its own schedule, instead of failing at once; an album named with a sign ("÷") can be found.

- A Usenet post's song is downloaded on its own, as a torrent's is, and moved into the library: the rest of the album is no longer downloaded and left in the client's finished folder, which SABnzbd never empties.

- Playlists: one song that can't be asked for no longer splits its artist's other songs into a request each; a song already asked for by someone else follows that request, and is asked for afresh should it be declined; when Lidarr can't take a playlist's requests, their failures are told together, as the playlist's other failures are.

- A music request is no longer marked failed when the music sync added its album in Lidarr at the same moment.

- Node's own warnings are written to the server's log, with where they came from.

- Retrying a music request sends Lidarr only what it still lacks: albums that came, or were taken off it, are no longer monitored and searched again.

- An indexer waiting out its limit, or Prowlarr not answering, has the search tried again in a few minutes instead of every minute.

- A song taken from an album no longer fails when its download turns out not to have it: the next release is tried. A Usenet download that renamed its files has the song found by its name.

- Taking a song from an album asks only Prowlarr's indexers that carry music and aren't paused, instead of waiting on every indexer, so searches take seconds rather than a minute or more. An album that found nothing is searched again after 1, 3, 6, 12 and 24 hours, one more try than before over the same two days.

- A song taken from an album could sit for hours on a torrent nobody was sharing. It now goes by Lidarr's delay profile for the artist: the protocol it prefers first (Usenet, including packed posts, the song found once unpacked; or a torrent with seeders), then the other, and a torrent nobody shares only when there's nothing else. A download bringing nothing no longer holds up the songs behind it, and a search Prowlarr didn't answer is tried again soon instead of counting as nothing found. Albums waiting to be searched again are searched on update.

## 2.4.0 (2 November 2026)

Library sharing for Plex, Jellyfin and Emby, a Helm chart for Kubernetes, and playlist imports that find more songs, say where each one stands, and carry on after a restart.

### New

- **Library sharing** (Settings → Media Servers): see who has each library on Plex, Jellyfin and Emby, and take a library from everyone, or give it to everyone, in one go, with a preview first and Undo after. An admin can also tick one person's libraries on their settings page (**Libraries**). ([guide](./docs/seerr-ai/media-servers.md#library-sharing))
- **A Helm chart for Kubernetes**, as Seerr has: `helm install seerr-ai oci://ghcr.io/corruptmods/seerr-ai-chart`. It's signed like the images, and listed with its settings in its [README](./charts/seerr-ai-chart/README.md). ([guide](./docs/seerr-ai/install.md#kubernetes))

### Changed

- **Music has its own Recent Music Requests row**, with the music rows, so Recent Requests keeps to films and series. A playlist import shows there as one card, as tall as the others, with a status pill and how its songs are getting on, instead of a card per artist. The playlist's name stays on its page, in notifications too.
- **Music status pills update on their own**, as films' and series' do: on album and artist pages, in Recent Music Requests and on a playlist's page.
- **The Music page loads from cache**, as Discover does, and refreshes behind it. Your Music Requests still asks the server first.
- **Notifications that ask for an approval open at it**: a pack waiting for approval opens its title's Backfill page at the plan, with that pack on show; several titles' packs, at Backfill's Awaiting approval; the admin agent asking for approval, at its proposal; asking a question, at the conversation and the box to answer in.

### Fixed

- A playlist song could be matched to a version that's only on other artists' compilations, and then "couldn't be requested", though the artist's own album or single had it. Matching now picks a version that can be requested, and songs already refused this way are matched again.
- The Requests page showed nothing with more than one status, kind or person ticked in its filters.
- A song taken from an album whose search found no download is looked for again a few times over about two days, instead of failing at once: indexers come and go.
- Songs from a playlist that couldn't be downloaded are told in one notification for the playlist, once they've settled, instead of one for each artist. A failure now names only the songs that failed, not every song in the request.
- A playlist song that couldn't be downloaded says so ("Couldn't be downloaded", with why under it), and **Try again** tries its request again.
- Matching a playlist's songs asks MusicBrainz less: a song found is kept, so requesting it needs no second lookup.
- Playlist songs with a part in brackets, such as "Song (Tide Me Over)" or "Song [Remix]", were all "Not found", however well MusicBrainz knew them. They're found now, the version named included, and songs already marked are looked for again on update. "(duet with …)" and "and" where MusicBrainz has "&" are found too.
- A playlist song showed "Can't be requested" when another song in the same request failed; each now shows its own state.
- Recently Added Music left out albums with only some songs here, so songs taken from albums (a playlist import's, say) never showed. They show now, as partly here, and an album moves back to the front when more of it arrives.
- Your Music Requests on the Music page showed what it had last time until the page was reloaded.
- Finding and requesting a playlist's songs carries on straight after a restart, not at the next hourly sync.
- A season Sonarr stopped looking for, with nothing downloaded, no longer stays Processing. Its request drops that season, so it can be requested again, or is declined if every season it asked for was dropped. With several Sonarr servers, a season one of them still downloads is left alone. (From Seerr.)

## 2.3.1 (1 November 2026)

A file size for each quality preset, including your own, a series no longer switching between Available and Partially Available every hour, and the Health page without screens of empty space.

### New

- **File size for each preset** (Settings → Quality): each preset's row has its own: Smaller files, Balanced, Best quality, or your own limit, in MB a minute in Sonarr v5 and GB a film in Radarr. Each choice shows the limit it sets. ([guide](./docs/seerr-ai/quality.md#file-size))

### Changed

- Balanced takes bigger files: a usual 1080p WEB-DL fits. In Sonarr v5, 1080p goes from 45 to 80 MB a minute; in Radarr, from 15 to 20 GB. The other presets rise with them.
- In Radarr, a film over its preset's size is never taken, instead of taken as a last resort.

### Fixed

- With TV details from TheTVDB (Settings → Metadata), a series whose seasons TMDB splits differently went back and forth between Available and Partially Available every hour. The hourly availability check now counts seasons the way the scans do.
- The Health page had several screens of empty space below its last section, most noticeable on a phone: the CPU and memory charts' hidden tables, there for screen readers, made the page that much longer.
- Save on a settings page no longer turns into a bar across the screen when it's already in view, as on Appearance: it floats only when the page is scrolled away from it.

## 2.3.0 (31 October 2026)

Quality profiles for Radarr and Sonarr, wrong Plex matches fixed from Seerr AI, playlists from Spotify and Apple Music, whole collections on lists, and Backfill that gives up on torrents that can't finish.

### New

- **Add a collection to a list**: a collection's page has Add to List. Each list says how many of its films it has, and picking one adds the rest. Adding several at once, from a collection or an import, sends one List Activity notice instead of none. ([guide](./docs/seerr-ai/discover-and-lists.md#watch-lists))
- **Save stays in view in Settings**: once something is changed, a settings page's Save floats at the bottom of the screen, above a phone's tab bar, wherever you've scrolled; saved, it goes back to the end of the page. Your own settings too.
- **On a phone, long names wrap instead of being cut off**: titles, release names, list, playlist, song and user names, menus, the calendar, AI results, request dialogs, Backfill, and Settings' lists.
- **Fix wrong Plex matches from Seerr AI** (Settings → Health → Folders matched to another title): a **Fix match** button looks the title up in Plex by the id Radarr or Sonarr has, matches it, and checks Plex took it, putting the old match back if not. **Fix automatically**, off to start, does it as problems are found, up to 20 a night from the nightly check, and still tells admins. Each fix can be undone. ([guide](./docs/seerr-ai/health.md#fixing-them-from-here-plex))
- **Quality profiles** (Settings → Quality): Seerr AI can set up Radarr and Sonarr profiles for you, from its own presets (SD to 2160p Remux, and Anime) or from TRaSH Guides, with a few adjustments on top: prefer usenet, file size, languages, HDR, x265, AV1, dual audio. Each server has its own. **What it does** says in plain words what each profile takes and prefers, and lets you try a release name. Every server starts Not managed and nothing is sent until you preview and apply, which marks each format as one to avoid or prefer and shows its progress; it only changes what it creates, sets where new requests go to its profiles, and History has Undo. Backfill can also step a title down a preset when nothing turns up, off unless you turn it on. ([guide](./docs/seerr-ai/quality.md))
- **Backfill gives up on torrents that won't finish**: when part of what's wanted is on no one's computer, after the stall time, even while the rest trickles in; and when one is so slow it would take over 3 days, after four hours at that pace. Either is replaced like a stalled one. Change the 3 days, or turn it off, in Settings → Backfill. Songs taken from albums too.
- **Backfill trusts seeders less**: a torrent whose swarm never had all of it is given up within its first hour, since an indexer's count of seeders is often old. A torrent its indexer says nobody seeds is never taken by itself, and is offered after ones that are seeded.
- **Artist pictures from TheAudioDB without a key**: its free key is used for artists Lidarr has no picture of. A supporter's key still takes its place when entered.
- The list Import says when a Trakt link can be pasted, and Settings → Services says what Trakt's Client ID is for.
- **"AI searching"**: while the admin agent looks for a title, its request card, the requests list and the title page's Backfill box say so, instead of "Nothing found". For admins it opens the agent's conversation, which now has a link back to the title's page.
- A downloading pill opens the title's downloads, not Plex (Play is in its details), and fits on a request card, cutting its words short rather than running off the edge.
- **Prowlarr moved to Settings → Services**, beside the other services. Backfill's settings say whether it is set up, and Backfill can't be turned on without it. Nothing needs setting up again.
- **Lists and playlists**: Watch Lists are now **Lists**, and a list can be a playlist. Paste a Spotify or Apple Music playlist's share link and its songs come in, now and daily after, each requested for you as a song within your song limit. What's over the limit is requested as it frees up, or, if you choose in Settings → Music, a big import waits for an admin as one batch. Songs MusicBrainz doesn't know (often music only on Spotify or YouTube) are listed apart and looked for again each week. ([guide](./docs/seerr-ai/discover-and-lists.md#playlists))
- An album's tracks show open on a phone too; they can still be folded away.
- Album, song and artist cards show their name along the bottom of the artwork, since covers seldom carry it.
- Backfill shows a long wait in days: "31 d 2 h", not "746 h 0 min".
- **The admin agent rides out an AI outage**: when OpenAI, Claude or your own AI server can't be reached or is busy, it tries again for about 8 minutes, then picks the conversation up by itself once the service answers, for up to a day.
- **Foldable phones**: checked on the iPhone Duo and Galaxy Folds, folded and unfolded, upright and on their side, and folding or unfolding mid-page. A title page's buttons now wrap their words on a narrow screen instead of running past the edge, and the top bar keeps clear of the Dynamic Island when a phone is turned on its side.
- **Profile pictures from Plex load from Seerr AI**, which keeps them, instead of from plex.tv on every page, which didn't always answer; if neither plex.tv nor the stand-in picture can be reached, a plain silhouette shows instead of a broken image.
- A download's pill ("Getting details", "Downloading 40%") was hard to read with an accent like Halloween's orange: dark words on its grey. Its words are now light.
- **No more zooming in when you tap a text box** on an iPhone or iPad: on a touch screen every field's text is at least 16px, the size below which Safari zooms. Pinching to zoom still works.
- **"AI searching" takes the place of a request's status pill** while the admin agent looks, instead of sitting beside it.
- The Lists page's new-list row: on a phone the name gets a line of its own, so it isn't cut off as you type, and everything is the same height.
- **Get New Seasons shows on for everyone** once anyone follows a series, such as whoever requested all of it, and the request window stops offering it there. Admins see who follows in its tip and can stop it for everyone.

### Changed

- sqlite3 6.0.1 (SQLite 3.52), from Seerr. Nothing to do: databases open as before.
- axios 1.21.0, Nodemailer 10.2.1 and express-rate-limit 8.7.1, from Seerr.

### Fixed

- Removing a title's file went to the default Radarr or Sonarr server when the title was on the first one added.
- **Keep** on Deleting Soon no longer postpones the deletion on a Maintainerr server that doesn't allow Keep.
- Quality profiles: Undo works after a new format was added, an apply that stopped part way can be undone, and Stop managing during an apply is kept. An apply no longer stops on a format name Radarr or Sonarr already has.
- **Download Check no longer rejects the same release over and over**: one numbered another way (S03E02 that's really S03E04) isn't searched for again by its number, which found it again on the next indexer; Backfill looks for the episode by its title. Each reject now says why, and what came after.
- Match Check on import no longer misses an older import looked at in the same run.
- **A fast download no longer skips "Adding to Plex"**: one grabbed and imported between two looks at the queue showed Requested until the next regular scan, up to 5 minutes. It's now found in Radarr's or Sonarr's history, shows Adding to Plex, and the quick scan runs a minute later, which also checks its match.
- On an iPhone, a page that gets shorter (a long Health list closing) no longer leaves empty space to scroll past: it goes back to its new end.
- On a busy server, music searches no longer fail for no reason.
- The admin agent: an admin who replies while it works can approve its changes at once, and a reply to a run stopped before it began is kept.
- Paging through one Health list runs only that check, not every check in its group.
- Two records that grew for as long as the server ran (where each episode's subtitles came from, and which client holds each torrent Download Check saw) are now trimmed.
- Backfill reads an NZB with a bad character in it, names Lidarr when Lidarr doesn't answer, and waits at most a day when an indexer says to wait.
- Testing a qBittorrent or Deluge password that's wrong says it's wrong, even while the right one is signed in.
- A Trakt link with a stray `%` in it, a music page number like `1e300`, and a Wikipedia biography with an odd character no longer fail.
- Transcribe Episodes says why it couldn't start, instead of "Bazarr did not answer".

### Security

- [CVE-2026-93753](https://github.com/advisories/GHSA-gcqx-w48m-w2h4): deepmerge, which email templates use, has no fixed release yet, so Seerr AI carries its own fix.
- **Subtitles**: only a subtitle Bazarr itself offered for that title can be downloaded. A forged choice could have made Bazarr run code (it reads the choice back as a Python object).
- After an admin moves Seerr AI to another Plex server, a person's Plex token for the old server is no longer sent to the new one.
- A personal or server API key can't link a single sign-on, Plex, Jellyfin or Emby account, or set a password to sign in with: a key that leaked could have made itself a full sign-in.
- **Personal CSS** is checked the way the browser reads it, so a stylesheet can't load from another server by hiding an address in a comment; only an admin sets an admin's CSS.
- **The admin agent**: approving one of its proposals no longer counts as an admin joining the conversation, which gave a run started by a report the admin's tools.
- **Quality profiles**: Apply applies only what the preview showed, and automatic TRaSH Guides updates never change the delay profile or choices that weren't applied.
- Backfill never imports a torrent's file named outside its own folder, and rTorrent removes only what is inside the torrent's folder. Prowlarr's key isn't sent on when an indexer redirects elsewhere.
- Playlist links: at most 20 every 10 minutes a person, and a playlist page is read only from Spotify or Apple Music, up to 5 MB. Setting a series' Plex subtitle is limited too.
- A long problem report can't stall the server any more, and nor can sign-in attempts with very long account names.
- follow-redirects 1.16.2 ([GHSA-mrwp-f3q8-3g9p](https://github.com/advisories/GHSA-mrwp-f3q8-3g9p)) and glob 14 ([GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)).

## 2.2.1 (27 October 2026)

Fixes from Seerr for Plex sign-in, scheduled jobs and override rules.

### Fixed

- With settings started afresh over an existing database, the owner signing in with Plex left Seerr AI with no media server set up. Plex is now set up as the media server, and the scheduled jobs start. (Upstream #3652)
- Setting up Jellyfin or Emby on a Seerr AI that already had people scheduled every job twice.
- The request window's override rule preview didn't match as the request would be sent: ticking **Anime** didn't bring in a rule for anime, and a server that isn't one of yours didn't fall back to the default server's rules.

## 2.2.0 (27 October 2026)

Seerr AI can now fetch one song instead of a whole album, and Backfill and the admin agent go after music Lidarr couldn't find. Music gets real charts: top songs, trending songs, top albums and top artists. AI Search finds music too, subtitle searches and transcriptions show what Bazarr is doing, the installed app comes back where you left it, and Seerr AI is ready for Radarr 7.

### New

- **Song requests**: ask for one song, not the whole album, from music search, an album's track list or the charts. Each version (radio edit, club mix) is asked for on its own. Lidarr fetches the single that has it; with Take Songs from Albums on, a song only on albums is taken from its album through Backfill, and with it off, such a song says **Only on albums**. On to start; turn it off in Settings → Music. ([guide](./docs/seerr-ai/music.md))
- **Your own Music page**: rows from the music you've asked for: your requests, more from your artists, and artists like yours. Only your own requests count.
- **Faster music search**: a search you've typed past no longer holds up the one you want, and songs are looked up alongside artists and albums.
- **Song downloads show their progress**: a song taken from an album shows **Downloading** on its track, its request and its album while it comes, as Lidarr's downloads do.
- **Backfill and the admin agent find music**: requested albums Lidarr couldn't find are followed and filled like series, matched track by track. Start search… lists albums too, and the admin agent can look for them, or request one that isn't in Lidarr. Turn it off with Music too in Settings → Backfill. ([guide](./docs/seerr-ai/backfill-and-agent.md#music))
- **Music charts**: Music and Discover get **Top Songs**, **Trending Songs** (the chart's songs out in the last month), **Top Albums** and **Top Artists**, from Apple Music's charts for your Discover region. Top Albums and Top Artists take over from Popular Albums and Popular Artists, which only counted ListenBrainz's own listeners. Songs can be requested from their cards. A chart fills in over a few minutes the first time, as each entry is matched to MusicBrainz. ([guide](./docs/seerr-ai/music.md))
- **Music in AI Search**: with music on, AI Search finds albums and artists too, from a description or a photo of an album cover. Tell it an album is missing songs, or an artist is missing albums, and it has Lidarr (and Backfill) look for them again.
- **Radarr 7**: works as before. If Radarr's Allowed Hosts (which Radarr 7 asks for) leaves out the name Seerr AI uses for it, the connection test, Health and errors say what to add, instead of "Failed to connect". Sonarr and Lidarr too.
- **Subtitle searches and transcriptions show what Bazarr is doing**: how long they've waited or run, how many jobs are ahead of them in Bazarr, its count of what it has checked, and when Bazarr has been busy with other jobs for hours.
- **The installed app comes back where you left it**: when iOS closes Seerr AI while it's in the background, switching back goes to the page you were on, not the home page. Closed for good (swiped away), it starts fresh.
- **Shared lists** open their cards' moving posters somewhere new each visit, rather than on the same ones every time.
- **Music in All search results** is on to start once Lidarr is set up, and off without it. Your own choice in Settings → Music stays put.
- **Music request cards** match films' and series': the cover behind them, the artist above, the album or song as the title.

### Fixed

- On Postgres, Backfill couldn't save a SABnzbd download's progress while it downloaded.
- A Plex watchlist longer than one page could show a page's titles again in place of the next page's.
- AI Search couldn't fix a title newer than the AI: it renamed it or said it didn't exist. It now finds the title on the server from your own words.
- Search's All said "No results." above the music it found.
- Music arriving together was announced as "ready to watch"; it's now ready to listen to.
- An album's tracks now show **Available** when the whole album is here.
- Long titles on request cards were cut short; they now take a second line, and the year (or a song's artist) shows on phones too.
- The artist page's **Request** button sat out of line with **Play** on phones.
- Asking for an album Lidarr didn't list yet, by an artist Lidarr already had, failed a week later with "Lidarr couldn't look up". Lidarr now adds it.
- **Transcribe** said a transcription was done as soon as Bazarr queued it, and **Search for the Missing** then sent every episode still missing to Whisper at once, before Bazarr had searched. That could jam Bazarr's queue for hours. Now each transcription waits until Bazarr saves the subtitle, the page says when one is waiting in Bazarr, and one Bazarr loses by restarting is asked for again.
- With subtitle downloads for several titles running in Bazarr at once, Seerr AI could follow another title's download and call yours finished. It now follows its own.

## 2.1.0 (24 October 2026)

Seerr AI now stops bad downloads before they start, takes "fix this show" from Siri, and its admin agent remembers what it has tried. Every download client Seerr AI supports now works with its newest version, and this release has security updates.

### New

- **Download Check**: rejects fakes, other titles, wrong episodes and copies no better than yours before they download, and sorts out imports that get stuck, importing the right title when it's named another way. Start with Report only, in Settings → Backfill. ([guide](./docs/seerr-ai/download-check.md))
- **Fix this show with Siri**: say "Fix this show" or "Fix this movie" while something is playing, and say what's wrong. It's reported and fixed like an issue; anything that replaces files is asked about first. Set it up in Profile → Settings → Siri. ([guide](./docs/seerr-ai/siri.md))
- **Understand Reports**: when a report's words don't say what to fix, the AI model works it out, if AI is set up. On issues, fixes that replace files are left for an admin.
- **Backfill goes by episode titles**: a file whose title is another episode's is taken as that episode, specials named only by their title are placed by it, and episodes numbered differently elsewhere are searched for by title.
- **The admin agent remembers each title**: what it searched, started, and what failed or was turned down, so the next conversation doesn't repeat it. You can also correct it while it works, and Stop ends it there.
- **Health shows Download Check and the agent**: what's waiting for you, and what both did this week.

### Fixed

Download clients, now checked against the real, newest version of each before every release:

- qBittorrent 5.2 and later couldn't be connected ("did not accept the username or password").
- Deluge 2 couldn't be connected ("Deluge: Unknown method").
- NZBGet: a request could fail with "socket hang up".
- rTorrent: a Backfill download with files skipped (most season packs) never finished.
- SABnzbd: a finished Backfill download couldn't be removed from SABnzbd's history, so it and its files stayed there.

Requests:

- A request approved at once could show as pending until the page was reloaded, and a movie requested by a request manager without auto-approve stayed shown as pending.
- A request for something already in your library was marked failed, not completed, when its server had been removed.
- One failed tag lookup in Radarr, Sonarr or Lidarr failed the whole request. It's now sent without the requester's tag.
- A series Sonarr has under a different TVDB id (after TheTVDB merges one) was reset on every Sonarr scan, and its request declined while it downloaded.
- Pointing Plex, Jellyfin or Emby settings at another server kept the old server's library switches, which landed on the new server's libraries.

Music:

- Names with punctuation (AC/DC, !!!, brackets, colons) or a word like AND searched wrongly, or failed with "MusicBrainz did not answer".
- An artist's picture went missing for a week after one failed try at TheAudioDB, and an empty answer from ListenBrainz left its Discover row empty for six hours.

The admin agent:

- It found more missing episodes each time it was asked. It now searches each one by number and title, opens season packs instead of grabbing them blind, and is reminded of any it never looked for before it stops.
- It trusted episode numbers over titles, so a release numbered its own way could go in as the wrong episode, or be passed over.
- It could take a release's sample file for the episode.

### Security

Package updates for advisories published on 23 October:

- [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828): body-parser 2.4.0, with Express 5.3.0: a compressed request with bytes after its body could tie the server up. Anyone who could reach Seerr AI could send one.
- [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c), [GHSA-4qv8-2p9j-2685](https://github.com/advisories/GHSA-4qv8-2p9j-2685), [GHSA-f72v-6w45-q472](https://github.com/advisories/GHSA-f72v-6w45-q472): undici 8.12.3 and 6.29.1: a reply with too many encodings, or an endless event stream, could take the server down. Only a service Seerr AI connects to could send such a reply.
- [GHSA-q7qp-rjg7-q26m](https://github.com/advisories/GHSA-q7qp-rjg7-q26m): multer 2.5.0: an upload cut off at the wrong moment could leave a request hanging. Not reachable: Seerr AI's API takes no uploads of that kind.
- [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5): zod 4.6.7: an oversized list could use up memory while being checked. Only through a signed-in user's request or the AI model's answers.
- [GHSA-8c8m-p3m8-cjg8](https://github.com/advisories/GHSA-8c8m-p3m8-cjg8), [GHSA-m943-m63m-w62w](https://github.com/advisories/GHSA-m943-m63m-w62w), [GHSA-85x2-q946-cp5h](https://github.com/advisories/GHSA-85x2-q946-cp5h): Nodemailer 10.1.4: a crafted email address could send mail to someone it didn't name. Only through an email address saved in Seerr AI.
- [GHSA-w74x-v6f9-j3xg](https://github.com/advisories/GHSA-w74x-v6f9-j3xg), [GHSA-wjr9-j795-jxcr](https://github.com/advisories/GHSA-wjr9-j795-jxcr), [GHSA-xhq7-xmqj-769h](https://github.com/advisories/GHSA-xhq7-xmqj-769h), [GHSA-333x-w4r6-6crp](https://github.com/advisories/GHSA-333x-w4r6-6crp): fast-uri 3.1.9, which checks addresses in API requests: crafted addresses were read wrongly. Reachable through API requests.

## 2.0.2 (23 October 2026)

### Security

- Next.js 16.4.2 ([security update](https://nextjs.org/blog/nextjs-security-update-october-14-2026)): two critical remote code execution flaws and a denial of service. None could be reached in Seerr AI, which uses the Pages Router, has image optimization off and runs on Alpine, but they're fixed all the same.
- [GHSA-rxp7-6hxx-x8q5](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5): ip-address 10.7.4, which rate limiting uses: a crafted IPv6 address took long to reject
- [GHSA-vpq2-c234-7xj6](https://github.com/advisories/GHSA-vpq2-c234-7xj6): @tootallnate/once 2.0.1; build only
- [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp): node-gyp and its download cache are no longer in the image. They only build sqlite3, and the cache has an advisory with no fix yet
- The image takes Alpine's security fixes when it's built
- `build.sh` checks for security advisories first, and builds nothing while one stands

## 2.0.1 (21 October 2026)

### Security

- Node.js 22.23.4 ([release notes](https://nodejs.org/en/blog/release/v22.23.4)):
  - CVE-2026-111497: out-of-bounds write in the Brotli decoder, possible remote code execution
  - CVE-2026-106069, CVE-2026-106072: TLS hostname checks passed with a non-canonical IP address
  - CVE-2026-105482: `dns.resolve` cut names off at a NUL byte
  - CVE-2026-105481: a keep-alive socket could take a response written before its request
  - CVE-2026-106074, CVE-2026-106073: random values repeated after a snapshot, and a permission model gap; neither is used by Seerr AI
- [CVE-2026-111756](https://github.com/advisories/GHSA-q3jh-wrc6-jgq8), [CVE-2026-111755](https://github.com/advisories/GHSA-8r9p-f939-6h3c): follow-redirects 1.16.1, so API keys and passwords aren't passed on to another site after a redirect
- [CVE-2026-87776](https://github.com/advisories/GHSA-vc2v-76pw-4v95): compression 1.8.2, a memory leak when a response is closed early
- [CVE-2026-106446](https://github.com/advisories/GHSA-8r5x-fm3f-whwj), [CVE-2026-106445](https://github.com/advisories/GHSA-p8wg-vrv2-v86f), [CVE-2026-106444](https://github.com/advisories/GHSA-xw65-4hp5-5hc7): handlebars 4.7.10, template injection; never used, as Seerr AI's emails use Pug, and no longer in the image
- [CVE-2026-93749](https://github.com/advisories/GHSA-68fv-2mgg-jv7q): source-map-js 1.2.2, slow source maps; build only

## 2.0.0 (20 October 2026)

Themes, single sign-on, Plex, Jellyfin and Emby together, music, personal API keys and more. Back up your config folder, and your PostgreSQL database if you use one, before updating: 2.0 changes the database, and going back to 1.1.0 isn't supported. `:1` stays on 1.1.0; use `:latest` or `:2` to get 2.0.

### New

- **Themes**: light or dark, accent colours, dark backgrounds and extras, chosen by each person; seasonal themes, theme files and custom CSS. ([guide](./docs/seerr-ai/themes.md))
- **Single sign-on** with Authentik, Authelia, Keycloak, Pocket ID, Google or any OpenID Connect provider, with rules for who may sign in. ([guide](./docs/seerr-ai/single-sign-on.md))
- **Plex, Jellyfin and Emby together**, in any combination, from Settings → Media Servers, with Play on each server and one profile for accounts on all of them. ([guide](./docs/seerr-ai/media-servers.md))
- **Music**: request albums or a whole discography through Lidarr, as one request, and hear when it arrives. ([guide](./docs/seerr-ai/music.md))
- **Personal API keys** for apps and scripts, off until an admin turns them on. ([guide](./docs/seerr-ai/account.md#api-keys))
- **Replace a whole season** from AI Search, an issue or the admin agent: the new copy is found before the old files go.
- **Leave out streaming services** in Filters and in custom streaming rows.
- **Anime** on Discover: an Anime This Season row and an Anime page.
- **Wrong-match alerts**: admins hear within minutes when a server files a new request under the wrong title.
- **Recover failed requests**: a request whose Radarr, Sonarr or Lidarr server is gone says why, with Retry and Edit.
- **Requested by** on title pages.
- **Decline with a reason**, shown to whoever asked and in their notification.
- **Override rules by age rating.**
- **Leave out anime made in** chosen countries (Settings → Services → Anime).
- **Arrange your own menu**: reorder and hide sidebar items.
- **Search by kind**: All, Movies, Series and Music.
- **Signed images** with a list of what's inside. ([how to check](./docs/seerr-ai/install.md#checking-an-image))

### Changed

- The Docker image is about 400 MB smaller.
- Settings → Media Servers is where Plex, Jellyfin and Emby are connected; connecting one lists its libraries straight away. Emby has its own settings, apart from Jellyfin's.
- **Enable Proxy Support** trusts only proxies on your network or Tailscale; add **Trust Cloudflare** or **Also Trust These Proxies** for others. ([guide](./docs/using-seerr/settings/network.md#enable-proxy-support))
- Webhooks can include the decline reason and Emby ids; music requests send `media_type` "music".
- The sign-in pages show the Seerr AI logo, and the sign-in buttons line up.
- Posters load before you scroll to them.
- Backfill waits out an indexer's download limit instead of trying again and again. A failed download says what replaced it; when the agent started it, the agent looks for another.
- The admin agent describes its steps in plain words.
- Notifications: Gotify priority 0 to 10, List Activity off channel pages, a 15-second limit per service.
- Logs say once when Radarr, Sonarr or Lidarr stops answering, and once when a server skips titles in a scan.
- About 15,600 more bits of text translated.

### Fixed

- A Plex account using the owner's email can no longer take over the owner's account on a Jellyfin or Emby server.
- The installed app no longer gets stuck on a sign-in page when a sign-in proxy's session runs out, and iPads open it on its launch screen.
- Plex sign-in works when the browser blocks its window, and says what went wrong.
- Import Plex Users no longer changes other people's details or stops halfway.
- Anime override rules follow Seerr's own idea of anime.
- Series limits on SQLite count the first day of the period.
- Approve and Delete in the Manage panel say what went wrong.
- Declining several requests at once resets each title.
- On PostgreSQL, requests finishing together all get their "available" message.
- On PostgreSQL, list and notification times are right again.
- Who Watched no longer counts 4K plays twice.
- Jellyfin and Emby get the nightly Match Check, and a library still being set up no longer floods the log.
- With CSRF Protection on, API keys can make changes; a wrong key is always refused.
- Telegram messages too long for a poster's caption are sent as text.
- Emails show the logo in Gmail and Outlook.
- Pages scroll again after a dialog closes on a phone.
- Builds from the dev branch no longer always say they're out of date.
- A Backfill search cut short by a restart no longer shows "Searching…" for hours.
- The admin agent's reply box grows as you type; AI Search hints fit on a phone.
- Settings sections that fail to load say so, with Retry.
- Icon-only buttons have names for screen readers.

## 1.1.0 (13 October 2026)

### New

- **Jellyfin and Emby** get Suggested for You, Who Watched, Pick for the Room, Catch Me Up, "up next" and Match Check.
- **40 languages**, notification titles included.
- **Trakt**: import public lists; your Trakt watchlist is requested for you.
- **Sonarr v5** support.
- **NZBGet, Transmission, Deluge and rTorrent**, for live progress and Backfill.
- **The admin agent can fix what's there**: replace a file, block a release group and more, after you approve.
- **Blocked release groups** (Settings → Backfill).
- **Collections in search.**
- **Your own Networks row.**
- **Watchlist sync for new people** (Settings → Users).

### Changed

- Signing in takes you back to the page you were on.
- Radarr searches straight away only once a film is out by its Minimum Availability.
- Studio and network pages follow your Discover region and language.
- On a phone, tapping a download pill shows the download.
- Import Jellyfin or Emby Users lists only new people.
- Tautulli moved to Settings → Services.
- Real logos for download clients, Bazarr and Tautulli.

### Fixed

- Safer accounts: user managers can't change admins, password changes ask for the current one.
- Blocklisted titles stay out.
- Backfill keeps downloads while a service restarts.
- Shared lists ask before using what you watched.
- A media server not answering no longer marks seasons deleted.
- Fewer repeat notifications; Approve from a notification works.
- Telegram accepts backticks and backslashes.
- Many smaller fixes to the agent, AI Search, jobs, Health and Settings.

## 1.0.0 (11 October 2026)

The first release: AI Search, Backfill and the admin agent, Health, watch lists, the release calendar and live download status.
