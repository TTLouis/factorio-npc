# Docker deployment

The Docker wrapper packages the same standalone-NPC runtime used by the Pterodactyl deployment. Local builds resolve `SGLUNA_SOURCE_REF` to an exact Git commit during the image build, so restarting a container never silently updates SGLuna code.

## Published prerelease image

Tagged prerelease images are published to GitHub Container Registry as:

```text
ghcr.io/ttlouis/factorio-npc:<release-tag>
```

For the first prerelease, the intended tag is:

```text
ghcr.io/ttlouis/factorio-npc:v0.1.0-pre.1
```

Published release images are built from the exact GitHub release commit. The prerelease workflow does not publish or move a `latest` image tag.

## Local Compose quick start

```bash
cp .env.example .env
# Edit .env and set OPENAI_API_KEY, OPENAI_API_BASEURL, and OPENAI_MODEL.
docker compose up -d --build
```

Persistent server state is stored in `${SGLUNA_DATA_DIR:-./data}`. This includes saves, `sgluna-config.json`, `data/server-settings.json`, mods, and SGLuna runtime state.

Follow logs with:

```bash
docker compose logs -f sgluna-factorio
```

To attach the terminal directly to Factorio stdin through the SGLuna supervisor:

```bash
docker attach "$(docker compose ps -q sgluna-factorio)"
```

Use Docker's normal detach sequence (`Ctrl-p`, `Ctrl-q`) instead of `Ctrl-c` if you want the server to keep running.

## Source selection

Stable local builds default to:

```text
SGLUNA_SOURCE_REF=main
```

The Docker build resolves that ref to an exact SHA and bakes that exact AIRI runtime into the image. Restarting the container does not update code. Rebuilding resolves the configured ref again.

To test ongoing NPC development instead, set `SGLUNA_SOURCE_REF=feat/npc-transition-work` explicitly. An exact 40-character commit SHA can be used for fully reproducible builds.

The build is layered so a source change doesn't download Factorio again. The system packages and the official Factorio archive (verified against Factorio's published checksums) are cached. The source install layer reruns whenever its build arguments change. With an exact commit SHA, a rebuild installs exactly that commit, and a new SHA reinstalls only the source. A branch ref such as `main` is resolved only when that layer reruns, so to pick up a branch's newer commits, set a new `SGLUNA_SOURCE_NONCE` (for example `SGLUNA_SOURCE_NONCE=$(date +%s) docker compose up -d --build`) or use a SHA. The installer re-verifies the cached archive and downloads Factorio itself if the cached version differs from the one it resolves. Published prerelease images are already pinned and do not need this rebuild behavior.

## Configuration boundary

The Compose environment mirrors the Pterodactyl egg's runtime parameters. Provider and Factorio credentials stay in `.env`/container environment; `OPENAI_API_KEY` is not persisted to `sgluna-config.json`. `FACTORIO_USERNAME` and `FACTORIO_TOKEN` are written only where Factorio requires them in `data/server-settings.json`.

Leave both Factorio account fields blank for a private/unlisted server. Set both to enable public listing.

## Factorio version

`FACTORIO_VERSION` is a build-time setting because the image includes the selected official Factorio headless build. Supported values follow the deployment installer: `latest`, `experimental`, or an exact `2.0.x` release.

Changing `FACTORIO_VERSION` requires rebuilding the image. A published release image retains the Factorio build selected when that release image was created.

## Shutdown

`docker stop` sends `SIGTERM` to the SGLuna supervisor. The supervisor shutdown path cancels AIRI work, saves Factorio, and stops the child process. Compose gives it a 90-second grace period by default.

## Notes

- The current tested/published container platform is `linux/amd64`.
- RCON remains internal to the container and is not exposed on the host.
- The legacy top-level `docker/` directory is not used by this deployment.
- `main` is the release baseline; `feat/npc-transition-work` remains the ongoing single-NPC development branch.


### Legacy deployment aliases

Fresh Compose examples use `SGLUNA_*`. The Dockerfile still accepts `AIRI_SOURCE_REF` and `AIRI_REPO` as compatibility build-arg fallbacks; when both old and new source refs are supplied, `SGLUNA_SOURCE_REF` wins.
