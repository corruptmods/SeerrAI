# Discover and lists

[← Seerr AI guide](./README.md)

## Your own home page

Press the pencil button at the bottom right of Discover.

- **Rows**: each row has **Show on my home page**. Your choice is yours alone; **Show All Rows** undoes it.
- **Admins** get **Customize Discover** to arrange the page for everyone: order, rows on or off, new rows. There, a row's switch is **Shown to everyone**, and the eye hides it for you only. Resetting to default clears what everyone hid.
- **Your networks**: in the **Networks** row, add networks by TMDB id, reorder or remove them (up to 50), or go back to the usual list.
- **Your menu**: the sidebar shows a handle, arrows and an eye on each item. Drag or move items into your order, and hide the ones you don't use. On a phone, press **Arrange menu** on the bar at the bottom; the first five items you show go on the bar (**On the bar**), the rest in its menu. **Reset Menu** puts everything back.

Save keeps it all; leaving drops it. Discover and Settings can't be hidden. Items you can't use stay hidden, and new items appear in their usual place.

### Rows Seerr AI adds

- **Deleting Soon** (first by default): what Maintainerr is about to delete, each with **Keep**. Hidden when nothing is due. Switch: `deletingSoon`.
- **Suggested for You**: from what you finished watching recently and TMDB's recommendations. Leaves out what you've started or is blocklisted. Hidden when there's nothing to go on. Switch: `suggestedForYou`.
- **Anime This Season**: anime series airing now. Open it for the **Anime** page: **This Season**, **Next Season**, **Last Season**, **Popular Series** and **Films**, narrowed with **Made in** (Japan, South Korea, China, the United States or anywhere else). Anime is what Seerr AI counts as anime everywhere (see [Anime](./requests-and-downloads.md#anime)), whatever your Discover language.
- **Music** rows, once music is set up. See [Music](./music.md).

## Leaving out streaming services

On the **Movies** or **Series** page, open **Filters** and find **Streaming Services**. Each logo has three states:

1. Pick it once: only what's on that service (**Only on**).
2. Pick it again: everything on it is left out (**Not on**); the logo is dimmed with a red ring.
3. Pick it a third time: cleared.

The chosen services are listed under **Only on** and **Not on** with a button to clear each. So "popular films not on the services I pay for" is a few taps. The choice stays in the page's address, so Back and shared links keep it.

Admins' custom streaming service rows on Discover (Customize Discover → **Create Custom Slider**) can leave services out the same way.

## Searching

Search results start with **All**, **Movies**, **Series** and, when music is on for you, **Music**. All is films, series, collections and people. The one you pick stays in the address. Filtering the Movies or Series page offers a link to search everything for the same words.

## Filter any page of posters

Every grid of posters (Discover pages, search, watchlists, recommendations, Suggested) has a filter box: **Filter by title, cast, character, director, studio**. It also matches networks, genres and keywords, and keeps loading more titles until it has found enough, or offers **Keep looking**.

## Request several at once

**Select** on a poster grid or a person's page lets you tick titles (or **Select all shown**), then **Request N**. After you confirm, they are requested one at a time; series with every season. Titles you can't request are dimmed. 4K isn't offered this way.

## Lists

**Lists** in the sidebar holds watch lists and, while music is set up, playlists. A new list is one or the other.

### Watch lists

Anyone signed in can make lists of movies and series and add to them from **Add to List** on posters and title pages, or from **Also add to** when requesting.

- **Sharing:** the owner shares a list with people (and can change who later). Each is invited first: **Accept** lets the list tell when everyone has finished a title and include them in Pick for the Room; **Leave List** turns it down. People on a list can add, remove and mark watched, or leave it. Only the owner renames, shares, deletes or imports. A list is seen only by its owner and the people it is shared with.
- **Sections:** **To watch** (here now), **Not Available Yet**, and **Watched**.
- **Where you are in each series:** series show "Up next S2E4 · 6 to catch up", "Not started" or "Caught up", from your own watch history (with Plex this needs Tautulli and a linked Plex account; with Jellyfin or Emby, a linked account on the server).
- **Sorting:** recently added, oldest added, title, newest or oldest release. Remembered on each device.
- **Activity:** people on a list are notified when someone adds, removes or marks something watched (the **List Activity** notification). Private lists send nothing.
- **Import:** the owner can paste a list of titles, one per line (bullets, numbers and years are fine). Each line is matched to TMDB and **you review every match** before anything is added; nothing is added on a guess. A collection adds all its films. Optionally, anything not already in the library is requested (at most 20 per import, with your usual permissions).
- **Import from Trakt:** paste the link to a public Trakt list, or to someone's public Trakt watchlist, instead (once an admin has set up Trakt in Settings → Services). Its titles come matched by their ids, up to 500, for you to review the same way.
- **Finished watching?** If the owner ticks the option on a list, Seerr AI notices when everyone on the list has watched a title, and offers to remove it. Nothing is removed on its own, and **Keep** stops it asking about that title. Switch: `watchSuggestions`.

### Playlists

A playlist holds songs. Its owner imports a Spotify or Apple Music playlist by pasting its share link. No account or key is needed: Seerr AI reads the playlist's public page.

- **What comes in:** the songs on it now, and each day, songs added to it since (**Playlist Sync**, hourly, reads each linked playlist once a day). Spotify links bring in up to 100 songs. A private playlist has to be shared or made public first.
- **Requested for you:** each song is found on MusicBrainz (the version nearest its length) and requested as a song in the owner's name, one request per artist, with their usual permissions and song limit. Songs already here or on their way are skipped.
- **Over the limit:** by default, what the limit can't take waits and is requested as it frees up, the next day and after. Or, under Settings → Music → **Big Playlist Imports**, an import of more songs than you set waits for an admin to approve, as one batch that doesn't count against the limit.
- **Not found:** a song MusicBrainz doesn't know can't be requested. Music that's only on Spotify or YouTube often isn't there. These are listed apart, looked for again each week, or now with **Try again**.
- **Each song says where it is:** finding it, about to be requested, waiting for your limit, waiting for approval, requested, here or on its way, declined, can't be requested, or not found.
- **Unlink** stops new songs coming in; the songs stay. A song taken off a linked playlist isn't read back in.

### Roulette

On a list with two or more titles: **Movie Roulette**, **Show Roulette** or **Surprise Me** spins through what is ready to watch and you haven't watched, and lands on one. **Spin again** avoids the last pick.

## Release calendar

**Calendar** in the sidebar: upcoming cinema, digital and physical releases and episode air dates for everything Radarr and Sonarr monitor, whether requested here or not. Four weeks at a time, up to twelve, filtered by movies or series. Switch: `releaseCalendar`.

## Search by voice or photo

- **Voice:** the microphone in the search box and in AI Search uses the browser's own speech recognition; nothing is recorded by Seerr AI. Shown on computers over HTTPS.
- **Photo:** in AI Search, **Send a Photo** of a poster, a cover, a screen or a message to find the titles in it. The photo is shrunk and stripped of location and camera details first. Needs AI ([AI](./ai.md)).

## The installed app

- **Startup screen** that matches the phone's splash screen.
- **Offline page that says what failed:** "You're offline", or "Can't reach Seerr" with **What happened**: no connection at all (this device's network, DNS or VPN), no answer in time, a Cloudflare error explained in words (521 nothing answered, 522 couldn't connect, 524 too slow…), or the proxy's error. It retries by itself and reloads once Seerr AI answers.
- **One notice at a time:** app updated, sign-in warnings, "Finished watching?", turning on notifications, adding a passkey, most important first.
- Pages are never served from a stale copy; images and Discover rows are cached, and one person's rows are never shown to the next person on the same device.
