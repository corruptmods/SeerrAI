# Discover and lists

[← Seerr AI guide](./README.md)

## Your own home page

Everyone has the pencil button at the bottom right of Discover.

- **Everyone:** **Choose what your home page shows**. Each row has a **Show on my home page** switch. That choice is kept for you alone; **Show All Rows** undoes it.
- **Admins:** **Customize Discover** arranges the page for everyone (order, rows on or off, new rows, reset). The switch on each row is **Shown to everyone**; the eye beside it hides that row for you only.
- **Your networks:** while editing, the **Networks** row lets you add networks by their TMDB id, reorder or remove them (up to 50), or go back to the usual list. Each person's list is their own.

Resetting the rows to default clears what everyone hid, because the rows are created again.

### Rows Seerr AI adds

- **Deleting Soon** (first by default): what Maintainerr is about to delete, soonest first, each with a **Keep** button. Hidden when nothing is due. Switch: `deletingSoon`.
- **Suggested for You**: built from what you finished watching recently (from Tautulli) and TMDB's recommendations, with recent watching counting more. Leaves out what you have started or what is blocklisted, and has its own page. Hidden when there is nothing to go on (no Tautulli, no linked Plex account, no history). Switch: `suggestedForYou`.

## Filter any page of posters

Every grid of posters (Discover pages, search, watchlists, recommendations, Suggested) has a filter box: **Filter by title, cast, character, director, studio**. It also matches networks, genres and keywords, and keeps loading more titles until it has found enough, or offers **Keep looking**.

## Request several at once

**Select** on a poster grid or a person's page lets you tick titles (or **Select all shown**), then **Request N**. After you confirm, they are requested one at a time; series with every season. Titles you can't request are dimmed. 4K isn't offered this way.

## Watch lists

**Watch Lists** in the sidebar. Anyone signed in can make lists of movies and series and add to them from **Add to List** on posters and title pages, or from **Also add to** when requesting.

- **Sharing:** the owner shares a list with people, who can then add, remove and mark watched, or leave it. Only the owner renames, shares, deletes or imports. A list is seen only by its owner and the people it is shared with.
- **Sections:** **To watch** (here now), **Not Available Yet**, and **Watched**.
- **Where you are in each series:** series show "Up next S2E4 · 6 to catch up", "Not started" or "Caught up", from your own Plex history (needs Tautulli and a linked Plex account).
- **Sorting:** recently added, oldest added, title, newest or oldest release. Remembered on each device.
- **Activity:** people on a list are notified when someone adds, removes or marks something watched (the **List Activity** notification). Private lists send nothing.
- **Import:** the owner can paste a list of titles, one per line. Each line is matched to TMDB and **you review every match** before anything is added; nothing is added on a guess. A collection adds all its films. Optionally, anything not already in the library is requested (at most 20 per import, with your usual permissions).
- **Finished watching?** If the owner ticks the option on a list, Seerr AI notices when everyone on the list has watched a title, and offers to remove it. Nothing is removed on its own, and **Keep** stops it asking about that title. Switch: `watchSuggestions`.

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
