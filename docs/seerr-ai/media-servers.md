# Plex, Jellyfin and Emby together

[← Seerr AI guide](./README.md)

Seerr AI can use Plex, Jellyfin and Emby at the same time, in any combination, one of each at most. A title is available when any of them has it, people sign in with whichever account they have, and title pages offer Play on each server.

With one server, nothing changes.

## For everyone

### Playing a title

On a film's or series' page, the main button plays it on one server: **Play on Plex**, say, on a server you have an account on. The arrow beside it lists the others (**Play on Jellyfin**, **Play on Emby**, or **Play 4K on …**). Each server's logo also sits beside the TMDB and IMDb links. On an iPhone or iPad, Plex links open the Plex app.

Elsewhere (status badges, request cards, issues) there's one Play link, on a server you have an account on.

### Linking your other accounts

If you have accounts on more than one connected server, link them so you can sign in with any of them and see your own servers first.

1. Sign in the way you always do.
2. Open **Profile → Settings → Linked Accounts**.
3. Press **Link Account** and choose the server.
4. Sign in there: Plex opens its own sign-in; Jellyfin and Emby ask for your username and password (Jellyfin also offers **Use Quick Connect**). Press **Link**.

The account must be yours, not linked to anyone else here, and allowed on that server (shared with you on Plex, not switched off on Jellyfin or Emby).

To unlink, press **Delete** beside it and confirm. **Delete** only shows while you have another way in: a password, another linked server, or single sign-on.

### Signing in

The sign-in page offers every server an admin allows: the Plex button, and the Jellyfin or Emby form (with a button to switch between them when both are connected). **Quick Connect** is Jellyfin's only.

You can sign in while any of your linked accounts still lets you in, so losing access to one server doesn't lock you out. A password still works while a server is down.

Signing in for the first time with an account whose email or name another account here already has is refused, with a message to sign in with that account and link the server instead. Nobody is merged or duplicated.

### Watch history

Suggested for You, Who Watched, Pick for the Room, Catch Me Up, "up next" on lists and AI Search use history from every server: Tautulli for Plex, Jellyfin and Emby themselves. Accounts on two servers count as one person.

Someone with Plex linked keeps their watchlist on Plex; everyone else keeps one here, with the star on a title.

## For admins

### Connecting a server

1. **Settings → Media Servers**. Each server has a card.
2. Press **Connect** on the one to add.
   - **Plex**: only the owner (the first account) can, because Seerr AI reaches Plex through the owner's Plex account. Sign in with the Plex account that owns the server, then pick the server or **Enter the address by hand**. A Plex account already someone else's here is refused.
   - **Jellyfin or Emby**: enter the address, then **Connect with** an administrator's sign-in (Seerr AI makes its own API key) or an API key and the **Administrator** to read libraries as. Tick **This is my account** to link it to yours. **External URL** is the address people use, for Play links.
3. The window lists the server's libraries: **Films and Series**, and **Music** while music is on. Switch on the ones to scan, then **Done**.

Libraries are scanned straight away, then on the usual schedule; no restart. **Edit** on a card opens the server's settings: libraries (**Sync Libraries** lists them again), its address, and for Jellyfin and Emby the **External URL** people use (often not the internal one) and the **Forgot Password URL** their sign-in links to. For Plex, the button beside the server list fetches your servers from plex.tv. Each server's scans are listed in **Settings → Jobs & Cache**.

Each card shows the server's name, libraries on, last scan, **Primary** on the primary one, and **Allow sign-in with …**.

With Plex connected, the Plex extras work whatever the primary server is: Tautulli (Settings → Services), **Auto-Import Plex Users** (Settings → Users) and Plex watchlists.

### The primary server

The server chosen at setup is primary; **Make Primary** changes it. The primary server comes first in lists and on the sign-in page, gives the single play link other apps reading the API get, and is the one whose account the owner can't unlink.

### Sign-in switches

Each card has **Allow sign-in with …**. The media server sign-in switch in **Settings → Users** turns them all on or off together. Turning off the last way anyone can sign in is refused.

**Settings → Users** has an **Import Users** button for each server. It also refreshes people imported before. People whose email or name another account already has are left out, and the import says who; they can link the server from their profile.

### Unlinking (owner)

The owner keeps their account on the primary server, and their Plex account while Plex is connected. A Jellyfin or Emby server is read as the administrator it was connected with, so the owner can unlink their own account there.

### Removing a server

**Remove** on a card. Before you confirm, it says how many people could then sign in only with a password, and how many not at all (people with single sign-on count as fine). Then:

- Its scans stop and its Play links go. An availability sync runs, so titles only it had are no longer available.
- Its address and libraries are kept for a quick reconnect; a Jellyfin or Emby API key is forgotten.
- People's accounts on it stay linked but unused, shown as **Not connected**. Nobody is deleted.
- Its Match Check findings go.

The last server can't be removed. Removing the primary makes the next one primary.

### Known limits

- **Episodes split across servers don't add up**: episodes 1 to 5 on Plex and 6 to 10 on Jellyfin show as partly available.
- **Open in Tautulli** in a title's Manage panel needs Plex as the primary server.
- The play counts in a title's **Manage** panel come from Tautulli, so they need Plex.

### Upgrading from 1.x

Nothing to do: your server becomes the primary one. A server set up with Emby has its data moved to Emby's own place automatically, once, on first start.
