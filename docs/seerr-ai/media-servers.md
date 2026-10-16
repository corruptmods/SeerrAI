# Plex, Jellyfin and Emby together

[← Seerr AI guide](./README.md)

Seerr AI can be connected to Plex, Jellyfin and Emby at the same time, in any combination: one of each at most. A title counts as available when it is on any of them, people sign in with an account on whichever they have, and a title's page offers Play on each server that has it.

With one media server nothing here changes anything: it works as it always has.

## Connecting a server

Everything is in **Settings → Media Servers**. There is a card for each of the three. A connected one shows its name, how many libraries are on, when it was last scanned, **Primary** on the primary server, and a switch for whether people may sign in with it; **Edit** opens its settings page, as **Settings → Plex**, **Settings → Jellyfin** and **Settings → Emby** did before (those addresses still work). The others have a **Connect** button.

- **Plex.** Only the owner (the first account) can connect Plex, because Seerr AI reaches Plex through the owner's Plex account. Sign in with the Plex account that owns the server: it is linked to your account here, and your email address here stays as it is. A Plex account that is already someone else's here is refused. Then pick one of your Plex servers, or enter its address by hand.
- **Jellyfin and Emby.** Enter the server's address, then either an administrator's username and password, from which Seerr AI makes its own API key, or an API key and the administrator to read libraries as. Tick **This is my account** to link that administrator account to yours, so you can sign in with it too. The **External URL** is the address people use, for Play links.

Then choose the libraries to scan. They are scanned straight away, then on the usual schedule; no restart is needed. Each server's scans are listed by name in **Settings → Jobs & Cache**.

Once Plex is connected, the Plex extras work whatever the primary server is: Tautulli in **Settings → Services**, **Auto-Import Plex Users** in **Settings → Users**, and Plex watchlists.

## The primary server

The server chosen when Seerr AI was set up is the primary one. **Make Primary** on another card changes it. The primary server:

- comes first: in lists of servers, on the sign-in page, and among a title's Play buttons for people with no account on any server;
- gives the single play link that other apps reading Seerr's API have always had;
- is the one whose account the owner can't unlink.

## What people see

- **Available means on any server.** A film or series is available, or available in 4K, when it is on any connected server. A season counts once any server has it.
- **Play buttons.** A title's page has **Play on Plex**, **Play on Jellyfin**, **Play 4K on Emby** and so on, one for each server that has it, the servers you have an account on first. Each follows the usual permissions, as before. Beside the TMDB and IMDb links, each server's logo links to the title there. On an iPhone or iPad, the Plex link opens the Plex app.
- **One link elsewhere.** Status badges, request cards and issues offer one Play link: on a server you have an account on (the primary one first), otherwise on the first server that has the title.
- **Watchlists.** Someone with a Plex account linked keeps their watchlist on Plex. Everyone else keeps one here, with the star button on a title. Discover's **Your Watchlist** row shows whichever is theirs.
- **Watch history** comes from every server that has it, Tautulli for Plex and Jellyfin and Emby themselves, for Suggested for You, Who Watched, Pick for the Room, Catch Me Up, "up next" on lists and AI Search. Someone with accounts on two servers counts as one person. The play counts in a title's **Manage** panel come from Tautulli, so they need Plex connected.

## Signing in

Each connected server has its own **Allow sign-in with …** switch on its card. The media server sign-in switch in **Settings → Users** stands for all of them: changing it turns them all on or off. Turning off the last way anyone can sign in is refused.

The sign-in page offers each server whose sign-in is on: the Plex button, and the Jellyfin or Emby form, with a button to switch between Jellyfin and Emby when both are connected. **Quick Connect** is Jellyfin's, so it is only offered for Jellyfin.

Someone may sign in while any of their accounts on a connected server still lets them in, so a friend no longer shared on Plex but still on Emby gets in. A password still works while a media server can't be reached.

Accounts are matched only by each server's own account, never by email across servers. Someone signing in for the first time with an account whose email or name another account here already has is turned away, with a message to sign in with that account and link the server from their profile. Nobody is merged or duplicated.

## Linking accounts

Anyone can link their accounts on other connected servers in **Profile → Settings → Linked Accounts**, and then sign in with any of them. Linking takes signing in there (with Plex, a password, or Jellyfin's Quick Connect), an account nobody else here has, and one that server lets in: shared on Plex, or not switched off on Jellyfin or Emby. Linking doesn't change what kind of account someone has, unless they only had a password.

An account can be unlinked while a password, another account on a connected server, or a [single sign-on](./single-sign-on.md) provider that is switched on still lets its owner in. The owner keeps their account on the primary server, and their Plex account while Plex is connected. A Jellyfin or Emby server's libraries are read as the administrator it was connected (or set up) with, so the owner can unlink their own account there too; only on a server with no such administrator recorded is it kept, until the server is connected again with one.

**Settings → Users** has an **Import Users** button for each connected server. People whose email or name another account already has are left out, and the import says who.

## Removing a server

**Remove** on a server's card disconnects it. Before you confirm, it says how many people could then only sign in with a password, and how many couldn't sign in at all; someone who can still sign in with a single sign-on provider that is switched on isn't counted. Then:

- its scans stop and its titles lose their Play links to it; an availability sync runs, so a title only that server had is no longer shown as available. If one is already running, it stops asking that server straight away and runs once more when it finishes;
- its address and libraries are kept, so connecting it again is quick, but a Jellyfin or Emby API key is forgotten;
- people's accounts on it stay linked but aren't used to sign in; their profile shows them as not connected. Nobody is deleted;
- its Match Check findings go, and a Match Check running at the time leaves them out too.

The last server can't be removed. Removing the primary server makes the next connected one primary.

## Known limitations

- **Episodes split across servers don't add up.** Episodes are counted on each server separately, so a season with episodes 1 to 5 on Plex and 6 to 10 on Jellyfin shows as partly available, not available.
- **Quick Connect is Jellyfin only.** Emby has no Quick Connect.
- **Open in Tautulli** in a title's **Manage** panel appears only when Plex is the primary server.

## Upgrading

An existing install needs nothing: the server it was set up with is the primary one and the only one connected, and everything works as before. On a server set up with Emby, Emby's ids for titles and people were kept where Jellyfin's go; they move to Emby's own place automatically, once, the first time Seerr AI starts after the update. A Jellyfin or Emby server set up before the administrator to read it as was recorded takes the owner's linked account as that administrator when Seerr AI starts.
