# Installing and updating

[← Seerr AI guide](./README.md)

Seerr AI runs the same way Seerr does: as a Docker container, on its own. Nothing from Seerr needs to be installed first.

## Install

The image is published for amd64 (PCs, servers, most NAS boxes) and arm64 (Raspberry Pi 4 and later, Apple Silicon):

| Tag | What |
|---|---|
| `ghcr.io/corruptmods/seerr-ai:latest` | The latest release |
| `ghcr.io/corruptmods/seerr-ai:1.2.3`, `:1.2` | A release, or the newest in a series |
| `ghcr.io/corruptmods/seerr-ai:develop` | A build of the `dev` branch, published when the maintainer chooses: newer than the latest release, and less tried |

With Docker Compose:

```yaml
services:
  seerr-ai:
    image: ghcr.io/corruptmods/seerr-ai:latest
    init: true
    environment:
      - TZ=America/New_York
      - LOG_LEVEL=info
      # PostgreSQL instead of SQLite (see docs.seerr.dev → Database configuration):
      # - DB_TYPE=postgres
      # - DB_HOST=postgres
      # - DB_NAME=seerr
      # - DB_USER=seerr
      # - DB_PASS=change-me
    ports:
      - 5055:5055
    volumes:
      - ./config:/app/config
    restart: unless-stopped
```

Or with `docker run`:

```bash
docker run -d --name seerr-ai --init \
  -e TZ=America/New_York \
  -p 5055:5055 \
  -v /path/to/config:/app/config \
  --restart unless-stopped \
  ghcr.io/corruptmods/seerr-ai:latest
```

The container runs as user and group 1000, so the `config` folder must be writable by them.

Open port 5055 and follow the setup: sign in with Plex, Jellyfin or Emby, then connect Radarr and Sonarr. Seerr's own [getting started](https://docs.seerr.dev/getting-started/) describes the setup screens, which are the same.

### Coming from Seerr

Point Seerr AI at the same `config` folder (or the same PostgreSQL database) and start it: it adds its own tables and columns. **Back the database up first**, since going back to Seerr afterwards isn't supported.

## Build it yourself

```bash
git clone <this repository> seerr-ai
cd seerr-ai
docker build --build-arg COMMIT_TAG="$(git rev-parse --short HEAD)" -t seerr-custom:latest .
```

`COMMIT_TAG` matters: it names the service worker, so a stale value keeps phones and installed apps on an old version after an update. Using the commit hash takes care of it. Use `image: seerr-custom:latest` with `pull_policy: never` in Compose. (The `compose.yaml` files in this repository are for development, not for running it.)

## Updating

With the published image, pull the new one and recreate the container:

```bash
docker compose pull && docker compose up -d
```

If you build it yourself, `build.sh` pulls the latest code and builds the image:

```bash
./build.sh
```

Then restart the container (or redeploy the stack).

### Updating with patches

Changes can also arrive as numbered patch files (`0154-….patch`). They go onto the `dev` branch (see [Branches](#branches)). Apply them in order with:

```bash
./apply-patches.sh /path/to/0154-*.patch /path/to/0155-*.patch
git push && ./build.sh
```

Each patch records the exact code it was made for and the code it must leave behind. `apply-patches.sh` refuses to start if your copy isn't the one the first patch expects (or has uncommitted changes), and undoes everything if any patch fails, so a half-applied update never reaches a build. If one stopped part-way, `git am --abort` clears it.

## Before an update that changes the database

Updates that add tables or columns carry migrations under `server/migration/`; they run when the new version starts. Back up first:

```bash
pg_dump -h <db-host> -U <db-user> -d <db-name> > ~/seerr-pre-$(date +%F).sql
```

For SQLite, copy `config/db/db.sqlite3` while the container is stopped.

## What to set up after installing

The fork's features find what they need on their own once these are connected; none is required.

| Connect | For |
|---|---|
| **Tautulli** (Settings → Services) | Suggested for You, "up next" on lists, Who Watched, Pick for the Room, Catch Me Up's stopping point |
| **Your download clients** (Settings → Services → Download Clients): SABnzbd, NZBGet, qBittorrent, Transmission, Deluge and rTorrent | Live download progress, and Backfill's downloads |
| **Prowlarr** (Settings → Backfill) | Backfill |
| **Bazarr** (Settings → Services) | Subtitles and transcription |
| **Maintainerr** (Settings → Services) | Deleting Soon and Keep |
| **An AI provider** (Settings → AI) | The AI features and the admin agent |
| **Web push** (Settings → Notifications) | Notifications on phones, including Backfill and Health alerts |

Then read **Settings → How It Works** in the app, and check **Settings → Health**.

## For developers

Building outside Docker, running the tests (SQLite and PostgreSQL), writing migrations, and the rules this fork learned the hard way are in [docs/FORK.md](../FORK.md).

## Branches

- **`dev`**: where changes land first, and what a self-built server runs. Its update check (Settings → About) compares against `dev`'s newest commits.
- **`main`**: releases only. It moves forward to `dev` when a release is cut, and is what GitHub shows first.

Day to day, stay on `dev` (`git switch dev`): `build.sh` pulls and builds whichever branch is checked out.

## Publishing a release (maintainers)

Bring `main` up to `dev`, then tag it:

```bash
git switch main && git merge --ff-only dev && git push
git tag ai-v1.2.3 && git push origin ai-v1.2.3
git switch dev
```

`--ff-only` refuses if `main` has anything `dev` doesn't, so `main` never gets ahead of `dev`.

The **Seerr AI Release** workflow (`.github/workflows/release.yml`) builds the image for amd64 and arm64 and publishes it to `ghcr.io/<owner>/seerr-ai`:

- **A release:** `git tag ai-v1.2.3 && git push origin ai-v1.2.3` publishes `:1.2.3`, `:1.2` and `:latest`, and creates the GitHub release that **Settings → About** checks for updates against. A version with a hyphen (`ai-v1.3.0-beta.1`) is a pre-release and leaves `:latest` alone.
- **Why `ai-v`:** Seerr's own tags (`v1.0.0` to `v3.x`) arrive in a copy that fetches Seerr as `upstream`, so Seerr AI's releases are tagged apart from them. Push one tag at a time; `git push --tags` would send Seerr's too.
- **`:develop`:** pushing to `dev` publishes nothing. When `dev` is ready to share: Actions → Seerr AI Release → Run workflow, with **Use workflow from** set to `dev`. Started from any other branch, it stops without publishing.
- **Cutting a release again:** move the tag (`git tag -f ai-v1.2.3 && git push -f origin ai-v1.2.3`); the images are rebuilt, and the existing release page is kept and published again (GitHub turns it into a draft while its tag is gone).

Each build takes about half an hour, because arm64 is built under emulation. While the repository is private, that comes out of its limited Actions minutes.

To let anyone pull the image, make the package public: GitHub → your profile → Packages → seerr-ai → Package settings → Change visibility.
