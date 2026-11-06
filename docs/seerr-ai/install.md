# Installing and updating

[← Seerr AI guide](./README.md)

Seerr AI runs the same way Seerr does: as a Docker container, on its own. Nothing from Seerr needs to be installed first.

## Install

The image is published for amd64 (PCs, servers, most NAS boxes) and arm64 (Raspberry Pi 4 and later, Apple Silicon):

| Tag | What |
|---|---|
| `ghcr.io/corruptmods/seerr-ai:latest` | The latest release |
| `ghcr.io/corruptmods/seerr-ai:1.2.3`, `:1.2`, `:1` | A release, or the newest in a series |
| `ghcr.io/corruptmods/seerr-ai:develop` | A build of the `dev` branch, published when the maintainer chooses: newer than the latest release, and less tried |
| `ghcr.io/corruptmods/seerr-ai:preview-<name>` | Something being tried out before it reaches `dev`. Only run one if you've been asked to |

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

Sonarr v4 and the Sonarr v5 beta both work. On v5, a series you set to another language in Sonarr shows there under its translated title; Backfill also searches under its original title, which is what most releases use. If you switch a series to another episode order in Sonarr v5 (DVD order, say), its season numbers no longer match TMDB's, so requests for single seasons of that series may pick the wrong season.

### Kubernetes

A Helm chart, signed like the images, installs Seerr AI on Kubernetes:

```bash
helm install seerr-ai oci://ghcr.io/corruptmods/seerr-ai-chart
```

It runs one pod (a StatefulSet: the database is in its `config` volume, 5 Gi to start; `replicaCount: 0` stops it and keeps the volume), reached through its service on port 80, or an ingress or Gateway API route you turn on. Set the time zone, or a PostgreSQL database, with `extraEnv` (`TZ`, `DB_TYPE`, `DB_HOST` and so on, as above). Every setting is in the [chart's README](../../charts/seerr-ai-chart/README.md). To check a chart before installing it:

```bash
cosign verify ghcr.io/corruptmods/seerr-ai-chart:1.2.0 \
  --certificate-identity https://github.com/corruptmods/SeerrAI/.github/workflows/charts.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Charts are only published from `main`, so a signature from any other branch fails this.

### Checking an image

Every published image is signed, and carries a list of everything inside it (an SBOM). With [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) you can check that an image was built by this project's own workflow before you run it:

```bash
cosign verify ghcr.io/corruptmods/seerr-ai:1.2.3 \
  --certificate-identity https://github.com/corruptmods/SeerrAI/.github/workflows/release.yml@refs/tags/ai-v1.2.3 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-github-workflow-trigger push \
  --certificate-github-workflow-sha <commit>
```

Use the version you run in both places, and for `<commit>` the commit the release's notes on GitHub name ("Built from commit …"). The identity accepts only the release workflow run for that tag, and the commit check only that tag's own commit, so a preview or a build run by hand from a branch fails it. `verify-attestation --type cyclonedx`, with the same options, checks the SBOM.

### Trying a beta

A beta is a preview of the next version, for people happy to try new things. When there is one, it's on the [releases page](https://github.com/corruptmods/SeerrAI/releases) as a pre-release, named like `2.1.0-beta.1`:

1. Back up the `config` folder, and your PostgreSQL database if you use one (see [backups](#before-an-update-that-changes-the-database)). A beta can change the database, and going back to an older version can't undo that.
2. Change the image to `ghcr.io/corruptmods/seerr-ai:` followed by the beta's version, and recreate the container.

`:latest` and `:1` don't move to a beta. A server running a beta is told about the next beta or release. Report problems in the [issues](https://github.com/corruptmods/SeerrAI/issues), saying which beta you run.

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

Before building, it checks for security advisories (`security-check.sh`, run in the image's own Node.js, so the host needs only Docker): every package that goes in the image, and whether Node.js 22 has a newer release with security fixes. If it finds anything, or can't check, nothing is built and it says what to fix. An advisory with no fix yet, for a package the server never loads, can be left out under `pnpm.auditConfig.ignoreGhsas` in `package.json`; the check still names it each time. Alpine's own security fixes are applied to the image on the first build of each day.

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

None of these is required; each feature finds what it needs once it's connected.

| Connect | For |
|---|---|
| **Other media servers** (Settings → Media Servers) | Plex, Jellyfin and Emby together. See [the guide](./media-servers.md) |
| **Tautulli** (Settings → Services, Plex only) | Suggested for You, "up next", Who Watched, Pick for the Room, Catch Me Up. Jellyfin and Emby need nothing |
| **Lidarr** (Settings → Services) | [Music](./music.md) |
| **Download clients** (Settings → Services → Download Clients) | Live progress, and Backfill |
| **Prowlarr** (Settings → Services) | Backfill, and songs taken from albums |
| **Bazarr** (Settings → Services) | Subtitles and transcription |
| **Maintainerr** (Settings → Services) | Deleting Soon and Keep |
| **An AI provider** (Settings → AI) | The AI features and the admin agent |
| **A single sign-on provider** (Settings → Users → Single Sign-On) | [Single sign-on](./single-sign-on.md) |
| **Web push** (Settings → Notifications) | Notifications on phones, including Backfill, Health and Wrong Match |

Then read **Settings → How It Works** in the app, and check **Settings → Health**.

## For developers

Building outside Docker, running the tests (SQLite and PostgreSQL), writing migrations, and the rules this fork learned the hard way are in [docs/FORK.md](../FORK.md).

## Branches

- **`dev`**: where changes land first, and what a self-built server runs. Its update check (Settings → About) compares against `dev`'s newest commits.
- **`main`**: releases only. It moves forward to `dev` when a release is cut, and is what GitHub shows first.

Day to day, stay on `dev` (`git switch dev`): `build.sh` pulls and builds whichever branch is checked out.

What `dev` has that the last release doesn't is listed under **Coming next** in [What's new](https://github.com/corruptmods/SeerrAI/blob/dev/CHANGELOG.md), when there is anything.

## Publishing a release (maintainers)

Bring `main` up to `dev`, then tag it:

```bash
git switch main && git merge --ff-only dev && git push
git tag ai-v1.2.3 && git push origin ai-v1.2.3
git switch dev
```

`--ff-only` refuses if `main` has anything `dev` doesn't, so `main` never gets ahead of `dev`.

An `ai-v` tag is only built once its commit is on `main` and **Seerr AI CI** has passed for it there; the workflow waits for a run that is still going, so tagging straight after the push is fine. A pre-release (`ai-v1.3.0-beta.1`) is tagged on `main` the same way.

The **Seerr AI Release** workflow (`.github/workflows/release.yml`) builds the image for amd64 and arm64, each on its own machine (arm64 on GitHub's arm64 runner), joins them into one image and publishes it to `ghcr.io/<owner>/seerr-ai` (and Docker Hub, below). Every image is then signed and given its SBOM, and both are checked; a release's page is only published once they pass.

- **A release:** `git tag ai-v1.2.3 && git push origin ai-v1.2.3` publishes `:1.2.3`, `:1.2`, `:1` and `:latest`, and creates the GitHub release that **Settings → About** checks for updates against. A version with a hyphen (`ai-v1.3.0-beta.1`) is a pre-release: it gets only `:1.3.0-beta.1`, and leaves `:1.3`, `:1` and `:latest` alone. Only installs already running a pre-release are told about one; everyone else is told only of a newer stable release. The release notes are the CHANGELOG.md section whose heading is the version (`## 1.2.3`, a date in brackets after it is fine, as in `## 2.0.0 (20 October 2026)`); a pre-release without one uses **Coming next**.
- **Why `ai-v`:** Seerr's own tags (`v1.0.0` to `v3.x`) arrive in a copy that fetches Seerr as `upstream`, so Seerr AI's releases are tagged apart from them. Push one tag at a time; `git push --tags` would send Seerr's too.
- **`:develop`:** pushing to `dev` publishes nothing. When `dev` is ready to share: Actions → Seerr AI Release → Run workflow, with **Use workflow from** set to `dev`.
- **A preview:** to let someone try work that isn't on `dev` yet, push a tag `preview-<name>` (`git tag preview-music-fix && git push origin preview-music-fix`) for `:preview-music-fix`, or run the workflow by hand from that branch for `:preview-<branch>` (a `/` in its name becomes `-`). A preview never moves `:latest` or `:develop`, and creates no release. Started by hand from `main`, the workflow stops without publishing: `main` only moves for a release.
- **The Helm chart** (`charts/seerr-ai-chart`) goes out on its own: the **Seerr AI Charts** workflow (`.github/workflows/charts.yml`) publishes a chart version that isn't in the registry yet whenever `main` gets a change under `charts/`, signs it, and pushes its Artifact Hub metadata beside it. For a release, raise `appVersion` in its `Chart.yaml` to the new version and `version` by one, and update the two version badges at the top of its README (or run helm-docs); on `dev`, the workflow lints it (it refuses a chart change without a new `version`) and installs it in a throwaway Kubernetes cluster. Make the `seerr-ai-chart` package public, as for the image.
- **Cutting a release again:** move the tag (`git tag -f ai-v1.2.3 && git push -f origin ai-v1.2.3`); the images are rebuilt, and the existing release page is kept and published again (GitHub turns it into a draft while its tag is gone).

Every image is also tagged `:sha-<commit>`. Building the two platforms side by side, natively, should be much quicker than the half hour arm64 used to take under emulation. GitHub's standard runners, the arm64 ones included, cost nothing for a public repository; a private copy uses its account's Actions minutes.

To let anyone pull the image, make the package public: GitHub → your profile → Packages → seerr-ai → Package settings → Change visibility.

#### Settings on GitHub

Nothing has to be set for GHCR: the workflow publishes with its own token. The rest is optional, under Settings → Secrets and variables → Actions:

| Name | Kind | What |
|---|---|---|
| `DOCKERHUB_USERNAME` | Secret | Your Docker Hub user. With the token, every image also goes to Docker Hub, signed the same way; without both, Docker Hub is skipped. |
| `DOCKERHUB_TOKEN` | Secret | A Docker Hub personal access token with **Read & Write** access (Docker Hub → Account settings → Personal access tokens). |
| `DOCKERHUB_IMAGE` | Variable | Where on Docker Hub, if not `<username>/seerr-ai` (an organisation's repository, say). |

For a release, the first check runs in the `release` environment, which GitHub creates on the first release. Unprotected, it changes nothing; to approve each release first, add required reviewers to it under Settings → Environments → release. Building, signing and publishing then wait for that one approval. Develop builds don't use the environment. Keep the Docker Hub secrets as repository secrets, not environment secrets, since the jobs that use them run outside the environment.

Create the Docker Hub repository yourself first, public so anyone can pull it; otherwise the first push creates it with your account's default visibility. Signing is keyless: each signature is recorded in Sigstore's public transparency log, naming this repository and the tag or branch it was built from.
