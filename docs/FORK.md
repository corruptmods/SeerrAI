# Seerr AI: developer notes

Seerr AI is an independent fork of [seerr-team/seerr](https://github.com/seerr-team/seerr),
branched at `59d5947b` and maintained independently. What it adds is
described for people using it in [seerr-ai/](./seerr-ai/README.md); this page
is for working on it. Upstream changes are not
merged back in.

`upstream` is kept as a git remote for reference — to read how something works
there, or to cherry-pick a fix worth having. Nothing is expected to merge
cleanly, and nothing has to.

Upstream `develop` has been read through `8f2eceea` (10 October 2026).
Its two security advisories there are covered: GHSA-xc6j-6p6h-p799 (other
people's details and issues in a title's media info) by `mediaForViewer`,
done here before upstream's fix; GHSA-8j73-j6rc-q8xh (notification
credentials in every embedded user) by `User.toJSON`. Start the next read
from that commit.

Unmerged upstream pull requests taken: #3571 (choosing the networks in the
Networks row), reworked: each person chooses their own (kept in their user
settings, saved with the rows they hide) where upstream has one list an
admin sets; the page carries no validation library; the editor loads only
while customizing.

## Building

```bash
git clone <your-remote> seerr
cd seerr
docker build --build-arg COMMIT_TAG="$(git rev-parse --short HEAD)" -t seerr-custom:latest .
```

`COMMIT_TAG` matters: it is the service worker's script URL, so a stale value
means clients keep an old worker after a deploy. Using the commit hash makes
that automatic.

Then recreate the container. The image is `seerr-custom:latest`; in Compose,
use `pull_policy: never` so it isn't looked for in a registry.

### Applying patches

Patches exported with `bin/export-patches.sh BASE FIRST_NUMBER OUT_DIR` carry
the tree they were made against and the tree they produce. Apply them with

```bash
./apply-patches.sh /path/to/00*.patch
```

It refuses to start if the working copy is not the tree the first patch was
made against, or has uncommitted changes, and undoes everything if any patch
fails, so a half-applied series never reaches a build. After the last patch
it checks the result is exactly the tree that was exported.

### Before a deploy that changes the schema

```bash
pg_dump -h <db-host> -U <db-user> -d <db-name> > ~/seerr-pre-$(date +%F).sql
```

Check for new files under `server/migration/` since the last deploy. Every
migration needs both a `postgres/` and a `sqlite/` variant.

To write one, let TypeORM generate it rather than hand-writing constraint
names: bring a scratch database up to date with `pnpm migration:run`
(`DB_TYPE=postgres` for Postgres; `NODE_ENV=production` with a scratch
`CONFIG_DIRECTORY` for SQLite, after `pnpm build:server`), then
`pnpm migration:generate`. Keep only the statements for your change: the
output also lists older naming differences in the fork's schema, which are
harmless and not worth a migration. Number it after the newest one.

## Tests

```bash
pnpm test                      # everything
NODE_ENV=test node server/test/index.mts server/routes/list.test.ts
```

Tests run on `node:test` with an in-memory SQLite database. Outbound network
is blocked, so any API client a test touches has to be stubbed. A run with
any failing test exits with 1.

### On GitHub

`.github/workflows/ci.yml` runs on every push and pull request to `dev` and
`main`: lint, formatting, types, translations in sync with the code
(`node bin/check-i18n.js`), a build, and the whole suite on SQLite. On
pushes it also runs the suite on Postgres, one file at a time, which takes
about an hour. A red cross on a commit links to the log of what failed.

### Against Postgres

Production runs Postgres; the default test run is in-memory SQLite. That gap
has let real bugs through — a `datetime` column Postgres rejects, a watchlist
loop that only reproduced on Postgres, and a helper that inserted a duplicate
row because it wrote through a second connection. Run the suite against
Postgres before deploying anything that touches entities, transactions or
subscribers:

```bash
docker run -d --name seerr-test-pg -e POSTGRES_USER=seerr \
  -e POSTGRES_PASSWORD=seerr -e POSTGRES_DB=seerr_test -p 5433:5432 postgres:16

NODE_ENV=test DB_TYPE=postgres DB_HOST=127.0.0.1 DB_PORT=5433 \
  DB_USER=seerr DB_PASS=seerr DB_NAME=seerr_test pnpm test --concurrency 1
```

`--concurrency 1` runs one test file at a time: they all share the one
database, and two at once reset it under each other.

Use a throwaway database. The schema is dropped on every run — never point
this at your real database.

Three things the harness does that are easy to trip over:

- **The database resets between every test.** Seed in `beforeEach`, not
  `before`.
- **API clients assign their methods as instance properties** in the
  constructor, so a prototype stub needs a setter that swallows the write:

  ```ts
  Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
    configurable: true,
    set() {},
    get() {
      return async () => ({ id: 1, title: 'Test' });
    },
  });
  ```
- **Faked timers and the Postgres pool.** `runWithMockTimers` replaces
  `setTimeout` and `clearTimeout`, which the database pool uses to close
  idle connections. The Postgres test config turns that reaping off
  (`idleTimeoutMillis: 0`); with it on, a connection checked out under a
  faked clock was closed ten seconds later mid-test, about one run in three.

## Rules learned the hard way

Each of these came from a bug that reached a running server.

1. **A new route must be declared in `seerr-api.yml`.** The OpenAPI validator
   runs before the router and answers undeclared paths with
   `{"message":"not found"}`. This silently disabled two finished features.
   `server/routes/apiSpec.test.ts` now fails for any route the app serves
   that the spec does not declare.
2. **Never build a Tailwind class name at runtime.** `list-cycle-${n}` was
   stripped from the production CSS and every list card rendered blank. Set
   the value inline, or keep the rule outside `@layer`.
3. **Check the compiled CSS, not just the component.** jsdom renders without
   the stylesheet, so a purged rule is invisible to component tests.
4. **`datetime` is SQLite-only.** Use `DbAwareColumn` for date columns or
   Postgres refuses to start — and the SQLite tests will not catch it.
5. **Any floating panel goes through the app's `Modal`.** A hand-rolled
   overlay inherits whatever clipping and stacking its parent happens to
   have. This was got wrong twice.
6. **Anything that waits on the network needs a timeout.** Three separate
   hangs — the image proxy, the service worker, Tautulli — were all an
   unbounded `await`.
7. **Do not save an entity loaded with relations** just to touch a column.
   Cascading relations get re-persisted from stale in-memory arrays; this
   made sharing a list fail for its entire life. Use `.update(id, {...})`.
8. **Test through the real scaffolding.** The OpenAPI validator and a missing
   `<Transition>` parent only showed up when the code ran inside the app.
9. **Keep heavy libraries off the pages everyone opens.** Import one
   function (`lodash/sortBy`, `validator/lib/isEmail`), never the whole
   package, and keep server-only code (zod schemas, address parsing) out of
   files the pages import. Something only used on demand (a dialog, an edit
   mode) loads with `useLazyModule`, not `next/dynamic`: a failed download
   under `next/dynamic` stays failed until the page reloads, which an
   installed app has no button for. A build's per-page weight is in
   `.next/build-manifest.json`; check it after adding a dependency.
10. **Decide what each viewer may see, on the server.** A title page once
    sent every requester's email and Plex id to anyone signed in, and issue
    reports to people without issue access. Send other people through
    `User.filter()` (see `server/lib/mediaForViewer.ts`), and check the
    permission in the route, not only by hiding the button.
11. **Sign-in starts a new session.** Use `startSession()` from
    `server/lib/signIn.ts`; setting `userId` on the existing session lets
    whoever planted that session id ride along.
12. **Every control needs a name.** An icon-only button or link is silent to
    a screen reader. Give it an `aria-label`; one wrapped in a `Tooltip` with
    plain text is named from the tooltip automatically. A second link to the
    same place (a poster beside its title) is `aria-hidden` and untabbable.
13. **A feature switch is enforced on the server.** Hiding a button is not
    turning a feature off: every route a switch covers checks
    `featureEnabled()` too.

## What's new

[CHANGELOG.md](../CHANGELOG.md) is written for the people running Seerr AI,
not for developers. A change they would notice adds a few friendly
sentences under **Coming next**: what they can now do, where to find it, and
anything they have to switch on. No code names, file names or jargon.
Changes nobody would notice (tests, refactors, the build) are left out. A
release renames **Coming next** to its version and date, and starts a new,
empty one.

## Layout of the fork's own code

| Path | What |
|---|---|
| `server/routes/list/` | lists, items, import — split by concern |
| `server/lib/list*.ts` | access rules, activity notifications, watch sync |
| `server/lib/notificationReconciler.ts` | dedup and catch-up delivery |
| `server/lib/requestDispatch.ts` | marking undispatchable requests failed |
| `server/constants/lists.ts`, `src/constants/lists.ts` | tuning knobs |
| `src/components/MediaLists/` | list UI |
| `src/hooks/useListDetail.ts`, `useMediaMarkers.ts` | list data and poster badges |
| `public/sw.js` | service worker |
| `server/lib/mediaServers.ts` | which media servers are connected, their settings, ids and clients |
| `src/utils/mediaServerAccounts.ts`, `src/utils/playLinks.ts` | people's server accounts, and which play link to offer them |
| `server/lib/oidc.ts`, `server/routes/oidc.ts` | single sign-on: talking to providers, the correlation cookie, finding or making the account |
| `server/lib/ai/` | AI: providers, limit and cache, credit, each feature's prompt |
| `src/components/Ai/`, `src/components/AiChat/` | AI panels and the AI button |
| `server/api/musicbrainz/`, `server/api/servarr/lidarr.ts` | MusicBrainz (its one shared queue) and Lidarr |
| `server/lib/music/`, `server/lib/scanners/music/` | music: matching albums, availability, completing requests; the music scans |
| `src/components/Music/` | music pages, cards, request cards and the artist's manage panel |

## Deliberate decisions

Do not undo these without reading why first — each was tried the other way.

- **No app shell caching.** Caching HTML caused a reload loop, a stale-build
  stall and a blank list card. Static assets, images and discover data are
  still cached.
- **No custom SWR cache provider.** A bounded LRU provider silently broke
  `mutate` in fifteen components, because the global `mutate` addresses swr's
  default cache and a provider takes the app out of it.
- **Roulette and list sections only offer watchable titles.** A partially
  available series counts; something still downloading does not.
- **Import never adds without review.** Automatic title matching gets things
  wrong, and silently adding the wrong film is worse than no feature.
- **Passkeys belong to the Application URL.** With it set (Settings →
  General), passkeys work only at that address and no Host header is trusted;
  a passkey made there cannot be used from a LAN IP. Changing the URL's host
  strands every passkey, so people sign in with a media server (or a
  password) once and add a new one.
- **Several media servers, one of each kind.** Plex, Jellyfin and Emby can
  be connected at once (Settings → Media Servers), at most one of each.
  `main.mediaServerType` is kept and means the primary server: the one
  whose links fill `mediaUrl`, `iOSPlexUrl` and `tautulliUrl` exactly as
  before, for API readers; `playLinks` has every server's. Every other
  question about servers goes through `server/lib/mediaServers.ts`, not
  `mediaServerType`. Emby has its own settings and columns rather than
  sharing Jellyfin's, so both can be connected. Accounts are matched only
  by each server's own id, never by email across servers: an email match
  let a Plex account take over the owner's account on a Jellyfin-first
  install. A new account whose email or name is taken is refused, not
  merged. Plex is reached through the owner's Plex token, so the owner
  links Plex to connect it. Episodes are counted per server, so a season
  split across two servers shows as partly available; that is a known
  limitation, told to admins in the guide.
- **Pages pick a play link for the viewer.** A title's page shows Play on
  each server; badges, request cards and issues show one, on a server the
  viewer has an account on (the primary one first), else the first that
  has it (`pickPlayLink` in `src/utils/playLinks.ts`). Notifications link
  to Seerr's own page, which is the same for everyone.
- **Two GitHub Actions workflows: checks and images.** `ci.yml` checks
  every push and pull request to `dev` and `main` (see Tests).
  `release.yml` builds and publishes the image for an `ai-v*` tag,
  `:preview-<name>` for a `preview-<name>` tag, and `:develop` when run by
  hand from `dev` (pushes to `dev` publish nothing; run by hand from any
  other branch it builds `:preview-<branch>`), so Seerr AI can be installed
  like Seerr, on its own. It builds the way upstream does: amd64 and arm64
  (the platforms upstream ships) each on their own runner, arm64 on
  GitHub's arm64 runner rather than under emulation, pushed by digest and
  joined into one multi-arch image; to GHCR, and to Docker Hub only when
  the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` secrets are set (as
  `<username>/seerr-ai`, or the `DOCKERHUB_IMAGE` repository variable);
  signed with cosign (keyless) with a CycloneDX SBOM attestation from
  Trivy, both verified before a release is published. Unlike upstream,
  every image is signed, not only releases, and the version comes from the
  tag (written into `package.json` for the build), not a release commit.
  The `ai-` prefix keeps releases apart from Seerr's own `v1.0.0`…`v3.x`
  tags, which arrive whenever Seerr is fetched as `upstream`; never
  `git push --tags`, which would send those too. It builds only when asked,
  and doesn't run the tests itself: they are `ci.yml`'s, so check a
  commit's run there (or run them locally, see Tests) before tagging it.
  Upstream's other workflows (docs, issue triage, Helm, its weekly Trivy
  scan to code scanning, Discord notices, `create-tag`) and its Helm chart
  aren't carried. Anyone can still build their own image with `build.sh`.
- **Update checks are against this repository.** `server/constants/project.ts`
  names it; Settings → About and the update check read its releases and
  commits. Change it if the repository is renamed. Both pick the latest
  release with `server/utils/releases.ts`: never a draft, a pre-release
  only for an install running one, matched to the version by its tag.
- **Two branches: `dev` and `main`.** Work and patches go onto `dev`, which
  a self-built server runs. `main` only moves for a release, fast-forwarded
  to `dev`, then tagged `ai-v…`. A release build checks for newer releases;
  any other build (version `develop-<commit>`) checks `dev`'s commits,
  matching the short hash build.sh uses as well as the full one.
- **A notice waits its turn.** Banners and pop-ups that ask something go
  through `NoticeQueue`, one at a time, most important first. A new one must
  report there rather than render on its own, or two will stack again.
- **The server compresses; the proxy passes it through.** Seerr sends
  brotli (gzip for older clients) for everything, API JSON included, which
  Nginx Proxy Manager never compressed. Hashed assets are immutable for a
  year; the service worker and `sw-precache.json` are never cached.
- **Per-person data is never shared between sign-ins.** The service worker
  empties its Discover cache whenever a sign-in or sign-out passes through
  it, and whenever a page load (`X-Seerr-User`) shows the signed-in person
  is not the one the rows belong to. Anything a device remembers for a
  person (a snoozed prompt) is keyed by their id.
- **Deleting a Plex user keeps them deleted.** The account's Plex id is
  recorded (`RemovedPlexAccount`) so the automatic import does not bring it
  back. Importing it by hand, or the person signing in with Plex while new
  Plex sign-ins are on, still does.
- **AI sends as little as it can.** Each feature sends a short instruction,
  titles as "Name (year)" and list positions rather than records, asks for
  compact JSON, and caps the answer. Thinking models are asked for their
  lowest effort, learned per model from their first refusal. Answers are
  cached, and a repeat costs nothing and does not count.
- **The AI key only goes where it was saved for.** It is never sent back to a
  browser, and changing the provider or address needs it typed again, so
  it cannot be sent to a server it was not meant for.
- **An AI answer is paid for before it is asked.** The daily limit is taken
  in one conditional update, so requests made together cannot run past it,
  and handed back when nothing usable came of it.
- **AI credit is worked out, not read.** Neither provider lets a program
  read an account's balance, so Settings → AI shows the balance an admin
  last entered less what has been spent since: from the provider's own
  spending report when an admin key is saved (the whole account, counted in
  whole UTC days), otherwise estimated from the tokens Seerr's own requests
  used (`ai_spend`) at prices the admin enters. The admin key is write-only
  like the API key, and a new provider starts the balance and key afresh.
  When the provider says the account is out of credit, that is shown there
  and to the person asking, and clears on the next answer.
- **Picks only include people who share a watch list with you.** What
  someone watches is otherwise only theirs and admins' to see. Admins can
  include anyone. People appear to the model as Viewer1, Viewer2.
- **AI never acts.** Every answer is text or titles found through TMDB.
  AI Search can set up putting titles on a list or requesting them, but only
  opens a window the person confirms, with every title shown and each one
  able to be left out; requests then follow the usual rules, one at a time.
  A model that gets something wrong can only mislead, never change anything.
- **Music is kept by artist, with albums as its parts.** An artist is a
  `Media` row (`mediaType` music, `tmdbId` 0, the MusicBrainz id in
  `foreignId`, the name in `foreignTitle`); each album is a `MusicAlbum`,
  as a season is a `Season`; a request is a `MediaRequest` holding
  `AlbumRequest`s. Lidarr keeps folders, profiles and tags on the artist,
  so one request for a whole discography is one approval and one set of
  choices; one row per album (as SeerrNG does) made a discography a pile
  of approvals fighting over the same artist. Requests, approvals, quotas,
  watchers and notifications came for free. Albums are completed and
  announced by the music scans (`lib/music/completion`), not the save
  hooks: they change through `update()`, which the hooks never see, and an
  artist's status says nothing about which albums one request asked for.
  For the same reason an artist becoming available never approves a
  pending music request. Lidarr is only ever told to monitor and search:
  `albumsToMonitor` unmonitors everything else, so it is used only for an
  artist being added, and an artist Lidarr has keeps its own settings.
- **Film and series code only ever sees films and series.** Everything that
  goes through titles in bulk (availability sync, Health, catch-up,
  watch history, Recently Added, the AI) is scoped with `VIDEO_MEDIA_TYPES`,
  and `server/lib/musicScope.test.ts` fails if a music row reaches any of
  it. Music's `tmdbId` of 0 never goes into a table keyed by `tmdbId`
  (Blocklist, MediaDeletion, Watchlist, list items): an artist's history
  is kept by `foreignId`, and clearing an artist records no deletion.
- **Permissions are a bigint.** Auto-Approve Music is 2^31, past what an
  integer column holds and past JavaScript's 32-bit `&`. `user.permissions`
  is a bigint read back as a number, and `hasPermission` uses arithmetic,
  not bitwise operators. Bit 0 and 2^29 were the only free ones below.
- **One MusicBrainz line for the whole server.** MusicBrainz allows one
  request a second from an address, and limits per instance of the client
  (upstream's way) let several run at once. Every request goes through one
  queue, people on a page ahead of scans; someone who would wait too long
  is told it is busy instead. Answers are kept in the database too, so a
  restart asks nothing again. Health judges MusicBrainz from how that
  queue has fared rather than spending a request on a check. A mirror
  (Settings → Metadata → Music) is not limited.
- **Single sign-on finds people by provider account only.** A provider
  (Settings → Users → Single Sign-On) signs someone in only through a
  link of the provider's id and its own id for them (`sub`, in
  `oidc_link`), made at the issuer the provider still has (a `sub` only
  means someone at the issuer that gave it, so changing the issuer URL
  leaves old links unusable; links from before issuers were recorded take
  the current one when used, or the old one when it changes), never by
  email: some providers let anyone put any email
  on an account, and an email match is how a Plex account could once take
  over the owner's. A new person is refused, unless the provider lets new
  people sign up; then they get an account, with the provider's email
  only when it is verified and nobody here has it, else a stand-in that
  isn't an email. An email someone here already has is refused with the
  usual "sign in and link it" message. A provider's id is made from its
  name once and never reused, even after it is removed, so its old links
  can never start matching another provider's people. Starting and
  finishing are pages the browser goes to, not calls: the callback is a
  link from the provider's site, so the state, PKCE verifier, nonce and
  return path ride in a signed, httpOnly, SameSite=Lax cookie (Strict
  would not come back), cleared on use. The callback answers with a page
  that moves on rather than a redirect, so a Strict session cookie (CSRF
  protection on) is sent with the page it lands on. Everything is built
  from the Application URL, never the request's Host. A provider sign-in
  is proof enough on its own (no `maySignIn`), and signing out ends only
  Seerr's session. A provider's rules for who may sign in
  (`requiredClaims`, upstream's idea, kept as `{ claim, value? }` and read
  from upstream's space-separated string too) are checked in the callback
  before anything else happens, so signing in, a new account and linking
  are all refused alike; they fail closed: a rule that can't be read, or
  userinfo that can't be, lets nobody in. Failed callbacks count toward
  the sign-in limit only with a genuine correlation cookie for that
  provider, so made-up callbacks can't lock out an address.
- **Trust Proxy trusts only proxies on the local network.** With it on,
  Express takes `req.ip` through loopback, link-local and private hops
  (`TRUSTED_PROXIES`), never every hop: with every hop trusted the address
  is whatever the sender wrote first in X-Forwarded-For, and the sign-in
  limits count by address.
- **Admins can remove someone's passkeys, not add or rename them.** For a
  lost device. The owner's and other admins' passkeys are the owner's to
  manage, as with passwords.
