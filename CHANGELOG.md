# What's new in Seerr AI

The newest changes are at the top. **Coming next** is what's on the `dev` branch and not in a release yet: it's what you get if you build from `dev` or run the `develop` image.

## Coming next

- **Plex, Jellyfin and Emby together.** You can now connect Plex, Jellyfin and Emby at the same time, in any combination, from the new **Settings → Media Servers** page: connect, edit or remove each one, choose which is the primary one, and choose whether people can sign in with it. A film or series counts as available when it's on any of them, and its page has a Play button for each server that has it, your own first. Everyone signs in with whichever account they have, and can link their accounts on the others in **Profile → Settings → Linked Accounts**. Watch history, Suggested for You, Who Watched, Match Check and Health cover every connected server. If you run one server today, there's nothing to do and nothing changes. If yours was set up with Emby, its data moves to Emby's own place by itself the first time Seerr AI starts. One thing to know: a season split across two servers (episodes 1 to 5 on Plex, 6 to 10 on Jellyfin) shows as partly available. The [guide](./docs/seerr-ai/media-servers.md) has the details.
- **Music.** Seerr AI can now take requests for music. Once an admin adds Lidarr under Settings → Services, music appears for everyone: a **Music** page, artists and albums in search, and new music rows on Discover. Everyone who can request films and series can now request music too: open an artist and pick the albums you want (or all of them), or request a single album from its page. However many albums you pick, it's one request, approved once, and you're told when they've all arrived. While Lidarr downloads, the status shows how far along it is, then "Adding to Plex" (or Jellyfin, or Emby) until your music library lists it. Admins switch on their music libraries under Settings → Plex, Jellyfin or Emby, can give people an album limit under Settings → Users, and can make someone's requests music-only with the **Request Music** permission. Health keeps an eye on albums that get stuck. Albums and artists appear as the same tiles as films and series, in rows and on full pages alike: what each one is in the corner (Album, EP, Single or Artist), its status opposite, and its name, year and a **Request** button when you hover over it or tap it. Album covers and pictures of artists are kept and made smaller on your server just like posters, so music pages load as quickly as the rest (with **Enable Image Caching** on in Settings → General; Settings → Jobs & Cache shows how much room they take). Don't want music? Admins can switch it off for everyone under Settings → Features, and anyone can switch it off for themselves. The [music guide](./docs/seerr-ai/music.md) has the details.
- **Anime on Discover.** A new **Anime This Season** row on the Discover page shows the anime series airing now. Open it for the full Anime page, where you can also see what premieres next season, what aired last season, the most popular anime series and anime films. The row is on for everyone; admins can move or turn it off under Customize Discover, and anyone can hide it from their own home page. Anime here is what Seerr counts as anime everywhere else, including when it sends a request to Sonarr or Radarr (see **Choose what counts as anime** below), so it shows even if your Discover Language is set to another language.
- **See who asked for a title.** A film's or a series' page now lists its requests under **Requested by**, among its details: who asked, when, whether it was for 4K, which seasons, and where it stands (pending, approved, declined and so on).
- **Say why you declined a request.** Declining a request now asks for an optional reason, like "Already on Netflix". The person who asked sees it on their request in Requests, on the title's page, and in the notification telling them it was declined (by email, Discord, Telegram and the other notification services). Admins see it in the title's Manage panel and its history. Declining from a phone notification's button still works, without a reason. Webhooks can include it with `{{decline_reason}}`.
- **Override rules by age rating.** An override rule can now match a title's age rating, like G and PG for films or TV-Y and TV-Y7 for series, so kids' titles can go to their own root folder or quality profile. Pick the ratings under **Age Ratings** when you add or edit a rule in Settings → Services. Ratings are TMDB's for your Discover Region (Settings → General), or the US rating when a title has none there.
- **Choose what counts as anime.** Seerr counts a title as anime when TMDB tags it as anime, wherever it was made, and counts animation made in Japanese too. Admins can now list countries whose anime-styled shows and films belong with the regular ones, under **Leave out anime made in** in Settings → Services → Anime: with the United States listed, Avatar: The Last Airbender and Castlevania aren't anime, while anything made in Japanese still is. If you already run Seerr AI, the United States is listed for you, so nothing changes unless you change it. The one setting is used everywhere: where requests go in Sonarr and Radarr, title pages, the Anime page and the Anime Check. The Anime page can also be narrowed to where a title was made, with **Made in**: Japan, South Korea, China, the United States or any other country.
- **Arrange your own menu.** Everyone can now put the sidebar in their own order and hide the items they don't use. Press the pencil button on Discover: the sidebar shows a handle to drag each item, arrows to move it and an eye to hide it, and on a phone the **Arrange menu** button on the bar at the bottom does the same. The sidebar and the phone use the same order, and on a phone the first five items you show are the ones on the bar, marked **On the bar** while you arrange them. Save keeps it, along with the rest of your home page, and **Reset Menu** puts everything back. It only changes your own menu. The usual order now has Watch Lists right after Series in the sidebar too, where it has always been on the phone. Discover and Settings are always there, and items added in later versions show up in their usual place.
- **The app, steadier on phones and iPads.** Installed on a current iPad, Seerr AI now opens on its own launch screen, pictures of artists load quicker on a phone, and if a sign-in page you put in front of Seerr ever answers in its place, the app no longer keeps that page instead of itself or its posters.

## 1.1.0 (13 October 2026)

Seerr AI on a Jellyfin or Emby server now does everything it does on Plex, it speaks 40 languages, Trakt lists and watchlists come in, Sonarr v5 is supported, and a long list of fixes makes everything safer and steadier.

### Search finds collections, and sign-in takes you back

- **Collections in search.** Searching for a franchise, like "Star Wars", now shows its collection alongside the films and series, and the card opens the collection page.
- **Back where you were.** If you open a link while signed out, or get signed out while using the app, signing in takes you to the page you were on instead of the home page. This works for every way of signing in.
- **Studio and network pages follow your Discover settings.** The region and original language you chose for Discover now apply when you open a studio or a network too, including from your Networks row.
- **Ratings show up more often.** When Rotten Tomatoes or IMDb is having trouble, a film's page still shows the rating from the other one.
- **No false alarm on series requests.** Requesting seasons someone else just requested, or that are already available, now tells you so instead of saying something went wrong.

### Radarr waits for the release you chose

- **Radarr follows your Minimum Availability.** When a movie is approved, Radarr is only asked to search straight away if it's already available by the Minimum Availability you set in Radarr. A film that's only in cinemas, with yours set to Released, is added and watched for instead, so you don't end up with a cinema recording. Set a movie to Announced and it's searched for right away, as before.
- **Movies with both a 1080p and a 4K copy in one Plex item** now show as available in both, not just 4K.
- **Plex or Jellyfin having a bad moment no longer marks seasons as deleted.** If your media server doesn't answer during the nightly availability check, everything is left as it was.
- **New files on Jellyfin and Emby show up sooner.** A movie the server hasn't finished reading yet now counts as available instead of waiting for the next scan.
- **Override rules for a second Radarr or Sonarr** now apply when a request goes to that server.
- **Watchlist Sync's schedule** can now be set in minutes, and the schedule editor opens on what each job is already set to.

### A big round of fixes

We went through all of Seerr AI looking for things that could go wrong, and fixed a lot of them. The ones you're most likely to notice:

- **Safer accounts.** Someone allowed to manage users can no longer change an admin's account, changing your password asks for your current one, and too many wrong passwords means a short wait. Changing your password signs you out everywhere else.
- **Blocklisted means blocklisted.** An old request can't sneak a blocklisted title back in anymore.
- **Fewer repeat notifications.** Muting your own request, or someone watching it, no longer sends the same notice again on every channel.
- **Backfill keeps your downloads.** If Sonarr, Radarr or your download client goes away for a while (an update, a reboot), Backfill now waits for it instead of giving up and deleting the download.
- **Shared lists ask first.** When someone shares a list with you, you choose whether to join it before it uses what you've watched. Everyone already on a list stays on it.
- **Staying signed in.** A server restart or a flaky connection no longer signs you out of the app.
- **Approve from a notification** now works, and in your language.
- **Subtitles with two Radarr or Sonarr servers** no longer show another title's subtitles.

Plus many smaller fixes to the admin agent, AI Search, the job schedule, Health and Settings. Everything you set up before keeps working as it did.

### New people, imports and notifications

- **Watchlist sync for new people.** In **Settings → Users** you can now have new people start with their Plex or Trakt watchlist requested for them, for movies, series or both. It's off unless you turn it on, and nobody who already has an account is changed.
- **Import Jellyfin or Emby Users** now only lists people you haven't imported yet, and each import also refreshes everyone already imported with their current name and picture, as Import Plex Users does. With nobody new to import, the button becomes **Sync**.
- **Notification titles in your language.** Lines like "Movie Request Approved" on Discord, email, Telegram, Slack, Pushover, Pushbullet, Gotify and ntfy now follow the language of the person they go to, or the channel's or server's language for a shared channel. Webhooks still get them in English, so nothing reading them breaks.
- **Telegram** no longer refuses a notification whose title or text has a backtick or a backslash in it.

### Trakt lists and watchlists

Paste a link to a public Trakt list into a list's **Import** and its titles come straight in for you to check, no title-by-title matching. And if you keep a Trakt watchlist, add your Trakt username in your profile settings: what you put on it gets requested for you, just like a Plex watchlist, on Plex, Jellyfin or Emby alike. An admin turns this on once in **Settings → Services → Trakt**.

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
