# Plex, Jellyfin, Emby and Silo together

[← Seerr AI guide](./README.md)

Seerr AI can use Plex, Jellyfin, Emby and Silo at the same time, in any combination, one of each at most. A title is available when any of them has it, people sign in with whichever account they have, and title pages offer Play on each server.

With one server, nothing changes.

**Silo support is new.** [Silo](https://siloserver.org) is itself pre-release: its API is fixed from Silo 1.0, and Seerr AI speaks that API (v2). Silo does everything below that the others do, except where [Silo can't](#what-silo-cant-do-and-why).

## What each server does

| | Plex | Jellyfin | Emby | Silo |
|---|---|---|---|---|
| Titles available, 4K kept apart (with a 4K Radarr or Sonarr) | Yes | Yes | Yes | Yes |
| Quality badges (resolution, HDR) | Resolution; HDR from Radarr's file or Plex's streams | Yes | Yes | Yes |
| Play on the server | Yes | Yes | Yes | Yes, in Silo's web app |
| Primary server, chosen at setup | Yes | Yes | Yes | Yes |
| Sign in | Plex button | Name and password, or Quick Connect | Name and password | Name and password (directory accounts too), or a code approved in Silo |
| Link accounts | Yes | Yes | Yes | Yes, and choose your household profile |
| Import users | Yes, and automatically | Yes | Yes | Yes |
| Remove Users Who Lose Access | Yes | Yes | Yes | Yes |
| Delete a user from the server too | Ends the Plex share | Switches the account off | Switches the account off | Switches the account off (needs the admin:users scope) |
| Watch history: Suggested for You, Who Watched, Pick for the Room, Catch Me Up, "up next" | Through Tautulli | From the server | From the server | From Seerr AI's copy of Silo's history |
| What you're playing, for Siri's "Fix this show" | Yes | Yes | Yes | Yes |
| Library sharing | Yes, through the owner's Plex account | Yes | Yes | Yes (needs the admin:users scope) |
| Show people only what their libraries hold | Yes | Yes | Yes | Yes, by account, not by profile |
| Match Check and checks after an import | Yes, and Seerr AI can fix the match | Yes | Yes | Yes (needs the admin:catalog:paths scope) |
| Music | Yes | Yes | Yes | No: Silo has no music libraries |
| Watchlist | On plex.tv | Here | Here | Here |
| Webhook ids | `{{media_plexRatingKey}}` | `{{media_jellyfinMediaId}}`, `{{requestedBy_jellyfinUserId}}` | `{{media_embyMediaId}}`, `{{requestedBy_embyUserId}}` | `{{media_siloMediaId}}`, `{{requestedBy_siloUserId}}` |
| Health: answering, version, its own warnings | Yes | Yes | Yes | Yes |

## For everyone

### Playing a title

On a film's or series' page, the main button plays it on one server: **Play on Plex**, say, on a server you have an account on. The arrow beside it lists the others (**Play on Jellyfin**, **Play on Emby**, **Play on Silo**, or **Play 4K on …**). Each server's logo also sits beside the TMDB and IMDb links. On an iPhone or iPad, Plex links open the Plex app. Silo's link opens the title in Silo's web app.

Elsewhere (status badges, request cards, issues) there's one Play link, on a server you have an account on.

### Which quality it's in

Beside **Available** (and **4K Available**) a title page shows what it's in: the resolutions (**4K**, **1080p**, **720p**, **SD**) and any HDR (**Dolby Vision**, **HDR10+**, **HDR10**, **HLG**). A series shows everything its episodes come in, across seasons. It comes from the last scan of each server that has the title, so nothing is asked of the servers when you open the page; without a 4K Radarr or Sonarr, a 4K version shows beside **Available**.

- **Jellyfin, Emby and Silo** say each version's resolution and HDR. A file Silo knows is HDR but not which kind shows no HDR badge.
- **Plex** says the resolution; HDR shows when Radarr's file for the film matches it, or when Plex sent its streams.
- **Radarr** fills in a film no server has scanned yet. Sonarr adds nothing: series come from the servers.

Only what is known is shown; titles show it after their next scan.

### Linking your other accounts

If you have accounts on more than one connected server, link them so you can sign in with any of them and see your own servers first.

1. Sign in the way you always do.
2. Open **Profile → Settings → Linked Accounts**.
3. Press **Link Account** and choose the server.
4. Sign in there: Plex opens its own sign-in; Jellyfin, Emby and Silo ask for your username and password. Jellyfin also offers **Use Quick Connect**, and Silo **Use a code from Silo instead**: approve the code in Silo, on any device, however you sign in there (closing the window withdraws the code). Press **Link**.

The account must be yours, not linked to anyone else here, and allowed on that server (shared with you on Plex, not switched off on Jellyfin, Emby or Silo).

**My profile** (Silo). A Silo account can hold several household profiles. Once Silo is linked, **My profile** under it picks which one is yours, so only that profile's watching counts as yours; **All profiles** counts the whole account. A code sign-in doesn't choose a profile; pick it here.

To unlink, press **Delete** beside it and confirm. **Delete** only shows while you have another way in: a password, another linked server, or single sign-on.

### Signing in

The sign-in page offers every server an admin allows: the Plex button, and the Jellyfin, Emby and Silo forms (with buttons to switch between them when more than one is connected). **Quick Connect** is Jellyfin's only.

**Silo.** Enter your Silo name and password; accounts Silo checks with a directory (LDAP) work the same way. Or press **Sign in with a code**: a code appears with a link to Silo's page; approve it in Silo on any device, signed in however you sign in there, and you're in. Seerr AI never stays signed in to Silo. If Silo says your account has a temporary password, change it in Silo first. If Silo has paused sign-in for your name after too many tries, wait a few minutes. Codes are limited per address.

You can sign in while any of your linked accounts still lets you in, so losing access to one server doesn't lock you out. A password still works while a server is down.

Signing in for the first time with an account whose email or name another account here already has is refused, with a message to sign in with that account and link the server instead. Nobody is merged or duplicated.

### Watch history

Suggested for You, Who Watched, Pick for the Room, Catch Me Up, "up next" on lists and AI Search use history from every server: Tautulli for Plex, Jellyfin and Emby themselves, and Seerr AI's own copy of Silo's history. Accounts on two servers count as one person.

**Silo.** Seerr AI copies Silo's play history every five minutes (the **Silo Watch History Sync** job; the first run copies everything). Each play keeps its film or series and episode even after Silo removes the item. Each night, Database Maintenance reads Silo's history again, moves plays to the series Silo now files them under, and drops only plays Silo no longer has: plays are never removed for their age. Someone with a profile chosen under **My profile** sees only that profile's plays; with none chosen, every profile on the account counts. If Silo can't be reached, features that need watch history say so rather than treating it as "watched nothing".

**Who Watched** counts Silo plays per household profile. A profile someone chose counts as that person; any other profile on the account counts as whoever linked the whole account, or appears under the profile's name.

Someone with Plex linked keeps their watchlist on Plex; everyone else keeps one here, with the star on a title.

## For admins

### Connecting a server

1. **Settings → Media Servers**. Each server has a card.
2. Press **Connect** on the one to add.
   - **Plex**: only the owner (the first account) can, because Seerr AI reaches Plex through the owner's Plex account. Sign in with the Plex account that owns the server, then pick the server or **Enter the address by hand**. A Plex account already someone else's here is refused.
   - **Jellyfin or Emby**: enter the address, then **Connect with** an administrator's sign-in (Seerr AI makes its own API key) or an API key and the **Administrator** to read libraries as. Tick **This is my account** to link it to yours. **External URL** is the address people use, for Play links.
   - **Silo**: see [Connecting Silo](#connecting-silo).
3. The window lists the server's libraries: **Films and Series**, and **Music** while music is on. Switch on the ones to scan, then **Done**.

Libraries are scanned straight away, then on the usual schedule; no restart. **Edit** on a card opens the server's settings: libraries (**Sync Libraries** lists them again), its address, and for Jellyfin, Emby and Silo the **External URL** people use (often not the internal one) and the **Forgot Password URL** their sign-in links to. For Plex, the button beside the server list fetches your servers from plex.tv. Each server's scans are listed in **Settings → Jobs & Cache**.

Each card shows the server's name, libraries on, last scan, **Primary** on the primary one, and **Allow sign-in with …**. A Silo card also says which features its key can't offer.

With Plex connected, the Plex extras work whatever the primary server is: Tautulli (Settings → Services), **Auto-Import Plex Users** (Settings → Users) and Plex watchlists.

### Connecting Silo

Silo can be connected beside the others, or chosen at setup (**Configure Silo**). Enter Silo's address (port 8090 by default), then either:

- **paste an API key** from a Silo administrator account with the `admin:monitor:read` and `libraries:read` scopes, or
- **sign in once as a Silo administrator**, so Seerr AI creates its own key with only those two scopes. If your household has PIN-protected or restricted profiles, Silo won't let a sign-in create a key: create one in Silo and paste it.

Two more scopes turn on more, on a key you paste:

| Scope | Turns on |
|---|---|
| `admin:users` | Library sharing, and switching someone's Silo account off when you delete them here |
| `admin:catalog:paths` | Match Check and the checks after an import, which need each title's folder |

Without them those features leave Silo out and say why. To add one later, make a key with it in Silo and paste it under **Settings → Silo**.

Seerr AI lists Silo's film, series and mixed libraries (a mixed one counts for both); book, podcast and manga libraries are left out. **Make Primary** and **Allow sign-in with Silo** work as for the others. Silo is scanned nightly in full and every five minutes for what was added; a file of 2160 lines or more is 4K. Titles are only marked gone when Silo answers, never while it's down.

**Silo's API version.** Seerr AI supports Silo's API v2. If Silo reports another version, Seerr AI stops reading Silo (scans, history) and says so on Health, while the other servers carry on.

**A different Silo at the same address** (a rebuilt server) is asked about first: Seerr AI says what connecting it removes (every link to a Silo account, Seerr AI's copy of the old Silo's watch history, and the old Silo's title ids) and goes ahead only when you press **Connect Anyway** (**Save Anyway** under Settings → Silo). People then link their Silo accounts again. Your own session stays, and if you connected by signing in to the new Silo, your account is linked to it. It's refused when the owner can sign in only with the old Silo, unless the owner connects it by signing in to the new one. While Seerr AI forgets the old Silo, nobody signs in, links or is imported through Silo and nothing is read from it; if Seerr AI stops part-way, it finishes at the next start. Until it's connected again, sign-ins and links from the new Silo are refused and Health says a different Silo answers.

**Seerr AI's key.** A key Seerr AI made is deleted when you connect again by signing in. **Remove** can't delete it (Silo doesn't let a key delete itself), so delete it in Silo if you won't reconnect.

### The primary server

The server chosen at setup is primary; **Make Primary** changes it. The primary server comes first in lists and on the sign-in page, gives the single play link other apps reading the API get, and is the one whose account the owner can't unlink.

### Sign-in switches

Each card has **Allow sign-in with …**. The media server sign-in switch in **Settings → Users** turns them all on or off together. Turning off the last way anyone can sign in is refused.

**Settings → Users** has an **Import Users** button for each server. It also refreshes people imported before. People whose email or name another account already has are left out, and the import says who; they can link the server from their profile. **Import Silo Users** lists Silo's switched-on accounts not yet imported.

A Silo account that is deleted or switched off no longer signs anyone in, and with **Remove Users Who Lose Access** on, such users are removed after two checks in a row, as on the other servers.

### Unlinking (owner)

The owner keeps their account on the primary server, and their Plex account while Plex is connected. A Jellyfin or Emby server is read as the administrator it was connected with, and Silo with its API key, so the owner can unlink their own account there.

### Library sharing

**Settings → Media Servers → Library Sharing** lists each connected server's libraries, and how many people have each. Plex counts the people the server is shared with; Jellyfin, Emby and Silo count every account except administrators, who always see everything. Open **Shared with …** to see who.

- **Remove from everyone** takes a library away from everyone at once; **Share with everyone** gives it to everyone who lacks it. Both show who would change before you confirm.
- It's done once, there and then: people shared with later are not changed.
- Nobody is left with no library: someone for whom it is the only one is left as they are, and the preview names them.
- Someone who had every library shared keeps the others, but new libraries are no longer shared with them on their own.
- **Recent Changes** lists what was changed here, with **Undo**. Undo gives each person back what they had, unless their libraries were changed again since.

To change one person's libraries, open their settings: **Users → (person) → Libraries**. It shows a box for each library on each server they have an account on. On Jellyfin, Emby and Silo, **Every library, new ones too** gives them everything. Plex can't do that from here; tick each library instead.

Plex sharing goes through the owner's Plex account, so it needs the owner's Plex account linked.

**Silo.** Silo accounts list their libraries, or follow their access group's list. **Every library** makes the account follow its group again, which for an account outside a group is every library, new ones too; when the group itself limits it, every library is listed for the account instead. Libraries Silo doesn't show here (books, say) are kept as they were. It needs the `admin:users` scope; without it Silo is left out with a note saying so.

### Showing people only what their libraries hold

**Settings → General → Show People Only What Their Libraries Hold**, off unless you turn it on. Then, for everyone but admins and people with **Manage Requests** or **Manage Users**:

- **Recently Added** leaves out titles that are only in libraries they can't open, say a film only in a grown-ups' library for a child's account.
- Title pages, cards, episode lists, lists, the Requests page and the AI show such a title as **Not in your libraries**, not as available, with no quality badges, and offer no **Request**: the file is already there, so a request would bring them nothing. To let them watch it, share the library with them.
- **Play** links go only to libraries they can open. A title in two libraries links the copy in theirs.
- With several servers, a title counts as theirs if any server lets them play it.
- Requests themselves work as before, except that adding a title to a list doesn't request it once they're over their limit, even with **Send Requests Over the Limit to Admins** on.

Which library holds a title comes from the library scans, so after turning it on run a **full scan** of each server once (Settings → Jobs & Cache). Until a title has been scanned it shows as before. The nightly **Database Maintenance** job forgets libraries a server no longer lists and servers no longer connected; a library turned off here keeps what it held, so its titles stay hidden from people who can't open it. People's libraries are read from plex.tv, Jellyfin, Emby or Silo and kept for 10 minutes (**Library Access** in Jobs & Cache; changes made from Seerr AI apply at once). If a server can't be read, that person sees everything as before until it can, and the log says so.

On Silo it uses the libraries Silo itself enforces for the account, its access group's included. Limits Silo sets on a household profile can't be read, so the account's limits apply.

It follows accounts linked to a connected server. Someone linked to none (a local or single sign-on account only, or one who unlinked theirs) opens no library, so sees nothing here as available; someone linked to Plex but not to a connected Jellyfin sees what only Jellyfin has as not in their libraries. Someone whose Silo account is switched off sees none of Silo's libraries.

### Deleting someone

**Delete** on a user can also take them off the server their account comes from: on Plex it ends the share, on Jellyfin and Emby it switches their account off, and on Silo it switches their account off (with the `admin:users` scope). Their account and watch history stay on the server. Administrators of the server are never switched off, and if the server refuses, the user isn't deleted here either.

### Removing a server

**Remove** on a card. Before you confirm, it says how many people could then sign in only with a password, and how many not at all (people with single sign-on count as fine). Then:

- Its scans stop and its Play links go. An availability sync runs, so titles only it had are no longer available.
- Its address and libraries are kept for a quick reconnect; a Jellyfin, Emby or Silo API key is forgotten.
- People's accounts on it stay linked but unused, shown as **Not connected**. Nobody is deleted.
- Its Match Check findings go. For Silo, Seerr AI's copy of its watch history goes too, and is copied again on reconnecting.

The last server can't be removed. Removing the primary makes the next one primary.

### What Silo can't do, and why

- **Music.** Silo has no music libraries, so music requests and album checks leave it out.
- **Fixing a wrong match from Seerr AI.** Silo's **Match Item** needs a curation permission that no scope Seerr AI asks for gives, so Match Check reports Silo's wrong matches with the id to enter, as for Jellyfin and Emby, but doesn't put them right itself.
- **Titles marked watched by hand, or imported into Silo** from another server or a watch service, aren't in the history Silo gives an API key, so Seerr AI doesn't see them. Only real plays count.
- **Profile limits.** Libraries Silo hides from one household profile can't be read; the account's libraries apply.
- **Signing in with Silo's single sign-on directly.** Seerr AI can't open Silo's own OpenID sign-in; people who sign in to Silo that way use **Sign in with a code** and approve it in Silo.
- **Tautulli extras** (Open in Tautulli, play counts in a title's Manage panel) are Plex's only.

### Known limits

- **Show people only what their libraries hold** covers films and series, not music. A title moved to another library shows in its old one until that library's next full scan.
- **Episodes split across servers don't add up**: episodes 1 to 5 on Plex and 6 to 10 on Silo show as partly available.
- **Open in Tautulli** in a title's Manage panel needs Plex as the primary server.
- The play counts in a title's **Manage** panel come from Tautulli, so they need Plex.

### Upgrading from 1.x

Nothing to do: your server becomes the primary one. A server set up with Emby has its data moved to Emby's own place automatically, once, on first start.
